// routes/reports.js
const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Reservation = require('../models/Reservation');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');


// GET /api/reports/events-overview - Listado de eventos con estadísticas de free tickets
router.get('/events-overview', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      search, 
      startDate, 
      endDate,
      sortBy = 'date',
      sortOrder = 'asc'
    } = req.query;

    // Primero, actualizar estados automáticamente
    await Event.updateEventStatuses();
    
    // Construir query
    let query = {};
    
    // Filtrar por estado
    if (status && status !== 'all') {
      query.status = status;
    }
    
    // Filtrar por búsqueda en título
    if (search) {
      query.title = { $regex: search, $options: 'i' };
    }
    
    // Filtrar por rango de fechas
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        query.date.$gte = new Date(startDate);
      }
      if (endDate) {
        query.date.$lte = new Date(endDate);
      }
    }
    
    // Configurar opciones de paginación y ordenamiento
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { [sortBy]: sortOrder === 'desc' ? -1 : 1 }
    };
    
    // Obtener eventos con paginación
    const events = await Event.find(query)
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit);
    
    // Obtener estadísticas de free tickets para cada evento
    const eventsWithStats = await Promise.all(
      events.map(async (event) => {
        try {
          // Calcular free tickets consumidos
          const freeTicketsConsumed = await Reservation.aggregate([
            { $match: { eventId: event._id } },
            { $group: { _id: null, total: { $sum: '$totalTickets' } } }
          ]);
          
          const consumed = freeTicketsConsumed[0]?.total || 0;
          let available;
          
          if (event.freeTickets === 0) {
            available = 'Ilimitado';
          } else {
            available = Math.max(0, event.freeTickets - consumed);
          }
          
          return {
            _id: event._id,
            title: event.title,
            date: event.date,
            location: event.location,
            status: event.status,
            price: event.price,
            freeTickets: event.freeTickets,
            freeTicketsAvailable: available,
            freeTicketsConsumed: consumed,
            hasFreeTickets: event.freeTickets > 0 || event.price === 0
          };
        } catch (error) {
          console.error(`Error procesando evento ${event._id}:`, error);
          return {
            ...event.toObject(),
            freeTicketsAvailable: 'Error',
            freeTicketsConsumed: 'Error',
            hasFreeTickets: false
          };
        }
      })
    );
    
    const total = await Event.countDocuments(query);
    
    res.json({
      events: eventsWithStats,
      totalPages: Math.ceil(total / options.limit),
      currentPage: options.page,
      total,
      filters: {
        status: status || 'all',
        search: search || '',
        startDate: startDate || '',
        endDate: endDate || ''
      }
    });
    
  } catch (error) {
    console.error('Error en reporte overview:', error);
    res.status(500).json({ 
      message: 'Error al generar el reporte de eventos',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/reports/events/:eventId/free-tickets - Obtener lista de personas con free tickets
router.get('/events/:eventId/free-tickets', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 20, export: exportType } = req.query;
    
    // Validar ObjectId
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    // Verificar que el evento existe
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    // Si se solicita exportación
    if (exportType === 'excel') {
      return await exportFreeTicketsToExcel(res, eventId, event);
    }
    
    // Si es una solicitud normal (paginada)
    const options = {
      page: parseInt(page),
      limit: parseInt(limit)
    };
    
    // Obtener reservas paginadas
    const reservations = await Reservation.find({ eventId })
      .sort({ reservationDate: -1 })
      .limit(options.limit)
      .skip((options.page - 1) * options.limit);
    
    // Extraer información de las personas
    const freeTicketHolders = reservations.flatMap(reservation => 
      reservation.tickets.map(ticket => ({
        nombre: ticket.nombre,
        apellido: ticket.apellido,
        telefono: ticket.telefono || 'No proporcionado',
        email: ticket.email || 'No proporcionado',
        reservationDate: reservation.reservationDate,
        reservationCode: reservation.reservationCode
      }))
    );
    
    const totalReservations = await Reservation.countDocuments({ eventId });
    
    res.json({
      event: {
        _id: event._id,
        title: event.title,
        date: event.date,
        location: event.location
      },
      freeTicketHolders,
      totalPages: Math.ceil(totalReservations / options.limit),
      currentPage: options.page,
      total: totalReservations,
      hasExport: true // Indicar que hay opción de exportar
    });
    
  } catch (error) {
    console.error('Error en lista de free tickets:', error);
    res.status(500).json({ 
      message: 'Error al obtener la lista de free tickets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Función para exportar a Excel
async function exportFreeTicketsToExcel(res, eventId, event) {
  try {
    // Obtener TODAS las reservas (sin paginación)
    const reservations = await Reservation.find({ eventId })
      .sort({ reservationDate: -1 });
    
    // Extraer información de todas las personas
    const freeTicketHolders = reservations.flatMap(reservation => 
      reservation.tickets.map(ticket => ({
        nombre: ticket.nombre,
        apellido: ticket.apellido,
        telefono: ticket.telefono || 'No proporcionado',
        email: ticket.email || 'No proporcionado',
        reservationDate: reservation.reservationDate,
        reservationCode: reservation.reservationCode
      }))
    );
    
    // Crear workbook de Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Lista de Free Tickets');
    
    // Estilos para el encabezado
    worksheet.columns = [
      { header: 'Nombre', key: 'nombre', width: 20 },
      { header: 'Apellido', key: 'apellido', width: 20 },
      { header: 'Teléfono', key: 'telefono', width: 15 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Código Reserva', key: 'reservationCode', width: 20 },
      { header: 'Fecha Reserva', key: 'reservationDate', width: 20 }
    ];
    
    // Estilo para el encabezado
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Agregar datos
    freeTicketHolders.forEach(holder => {
      worksheet.addRow({
        nombre: holder.nombre,
        apellido: holder.apellido,
        telefono: holder.telefono,
        email: holder.email,
        reservationCode: holder.reservationCode,
        reservationDate: holder.reservationDate.toLocaleString('es-ES')
      });
    });
    
    // Agregar información del evento como encabezado
    worksheet.insertRow(1, [`Evento: ${event.title}`]);
    worksheet.insertRow(2, [`Fecha: ${event.date.toLocaleDateString('es-ES')}`]);
    worksheet.insertRow(3, [`Ubicación: ${event.location}`]);
    worksheet.insertRow(4, [`Total de personas: ${freeTicketHolders.length}`]);
    worksheet.insertRow(5, ['']); // Línea en blanco
    
    // Combinar celdas para los títulos
    worksheet.mergeCells('A1:F1');
    worksheet.mergeCells('A2:F2');
    worksheet.mergeCells('A3:F3');
    worksheet.mergeCells('A4:F4');
    
    // Configurar respuesta para descarga
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="free-tickets-${event.title}-${event.date.toISOString().split('T')[0]}.xlsx"`);
    
    // Enviar el archivo Excel
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Error al exportar a Excel:', error);
    res.status(500).json({ 
      message: 'Error al exportar la lista a Excel',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// GET /api/reports/events/:eventId/free-tickets/export - Endpoint alternativo para exportar
router.get('/events/:eventId/free-tickets/export', async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // Validar ObjectId
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    // Verificar que el evento existe
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    await exportFreeTicketsToExcel(res, eventId, event);
    
  } catch (error) {
    console.error('Error en exportación:', error);
    res.status(500).json({ 
      message: 'Error al exportar la lista',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;