// routes/reports.js
const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Reservation = require('../models/Reservation');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');


// GET /api/reports/events-overview - Listado de eventos con estadísticas COMPLETAS
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

    // Actualizar estados automáticamente
    await Event.updateEventStatuses();
    
    // Construir query (igual que antes)
    let query = {};
    if (status && status !== 'all') query.status = status;
    if (search) query.title = { $regex: search, $options: 'i' };
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { [sortBy]: sortOrder === 'desc' ? -1 : 1 }
    };
    
    const events = await Event.find(query)
      .sort(options.sort)
      .limit(options.limit)
      .skip((options.page - 1) * options.limit);
    
    // ✅ NUEVO: Obtener estadísticas COMPLETAS para cada evento
    const eventsWithCompleteStats = await Promise.all(
      events.map(async (event) => {
        try {
          // Estadísticas de TODAS las reservas
          const stats = await Reservation.aggregate([
            { $match: { eventId: event._id } },
            {
              $group: {
                _id: null,
                totalReservations: { $sum: 1 },
                totalTickets: { $sum: { $size: '$tickets' } },
                totalRevenue: { $sum: '$totalAmount' },
                freeReservations: {
                  $sum: { $cond: [{ $eq: ['$totalAmount', 0] }, 1, 0] }
                },
                paidReservations: {
                  $sum: { $cond: [{ $gt: ['$totalAmount', 0] }, 1, 0] }
                },
                avgTicketsPerReservation: { $avg: { $size: '$tickets' } }
              }
            }
          ]);

          const eventStats = stats[0] || {
            totalReservations: 0,
            totalTickets: 0,
            totalRevenue: 0,
            freeReservations: 0,
            paidReservations: 0,
            avgTicketsPerReservation: 0
          };

          // Calcular ocupación (si el evento tiene capacidad)
          let occupancyRate = 'N/A';
          if (event.capacity && event.capacity > 0) {
            occupancyRate = `${((eventStats.totalTickets / event.capacity) * 100).toFixed(1)}%`;
          }

          // Información de free tickets (mantener compatibilidad)
          let freeTicketsAvailable = 'N/A';
          if (event.freeTickets > 0) {
            const freeTicketsUsed = await Reservation.aggregate([
              { $match: { eventId: event._id, totalAmount: 0 } },
              { $group: { _id: null, total: { $sum: { $size: '$tickets' } } } }
            ]);
            const used = freeTicketsUsed[0]?.total || 0;
            freeTicketsAvailable = Math.max(0, event.freeTickets - used);
          }

          return {
            // Información básica del evento
            _id: event._id,
            title: event.title,
            date: event.date,
            location: event.location,
            status: event.status,
            price: event.price,
            capacity: event.capacity,
            
            // ✅ NUEVAS ESTADÍSTICAS COMPLETAS
            statistics: {
              totalReservations: eventStats.totalReservations,
              totalTickets: eventStats.totalTickets,
              totalRevenue: eventStats.totalRevenue,
              freeReservations: eventStats.freeReservations,
              paidReservations: eventStats.paidReservations,
              avgTicketsPerReservation: Math.round(eventStats.avgTicketsPerReservation * 10) / 10,
              occupancyRate: occupancyRate
            },
            
            // ✅ Mantener compatibilidad con free tickets (para no romper frontend existente)
            freeTickets: event.freeTickets,
            freeTicketsAvailable: freeTicketsAvailable,
            freeTicketsConsumed: eventStats.freeReservations,
            hasFreeTickets: event.freeTickets > 0 || event.price === 0,
            
            // ✅ Indicadores de rendimiento
            performance: {
              isFreeEvent: event.price === 0,
              hasPaidTickets: eventStats.paidReservations > 0,
              revenuePerTicket: eventStats.totalTickets > 0 
                ? (eventStats.totalRevenue / eventStats.totalTickets).toFixed(2) 
                : 0
            }
          };
        } catch (error) {
          console.error(`Error procesando evento ${event._id}:`, error);
          return getErrorEventStats(event, error);
        }
      })
    );
    
    const total = await Event.countDocuments(query);
    
    res.json({
      events: eventsWithCompleteStats,
      totalPages: Math.ceil(total / options.limit),
      currentPage: options.page,
      total,
      filters: {
        status: status || 'all',
        search: search || '',
        startDate: startDate || '',
        endDate: endDate || ''
      },
      // ✅ Estadísticas globales del reporte
      summary: await getReportSummary(query)
    });
    
  } catch (error) {
    console.error('Error en reporte overview:', error);
    res.status(500).json({ 
      message: 'Error al generar el reporte de eventos',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Función para obtener resumen global del reporte
async function getReportSummary(query) {
  const eventsInReport = await Event.find(query);
  const eventIds = eventsInReport.map(e => e._id);
  
  const globalStats = await Reservation.aggregate([
    { $match: { eventId: { $in: eventIds } } },
    {
      $group: {
        _id: null,
        totalEvents: { $addToSet: '$eventId' },
        totalReservations: { $sum: 1 },
        totalTickets: { $sum: { $size: '$tickets' } },
        totalRevenue: { $sum: '$totalAmount' },
        freeReservations: { $sum: { $cond: [{ $eq: ['$totalAmount', 0] }, 1, 0] } },
        paidReservations: { $sum: { $cond: [{ $gt: ['$totalAmount', 0] }, 1, 0] } }
      }
    }
  ]);
  
  const stats = globalStats[0] || {
    totalReservations: 0,
    totalTickets: 0,
    totalRevenue: 0,
    freeReservations: 0,
    paidReservations: 0
  };
  
  return {
    totalEvents: eventsInReport.length,
    totalReservations: stats.totalReservations,
    totalTickets: stats.totalTickets,
    totalRevenue: stats.totalRevenue,
    freeReservations: stats.freeReservations,
    paidReservations: stats.paidReservations,
    freeVsPaidRatio: stats.totalReservations > 0 
      ? `${((stats.freeReservations / stats.totalReservations) * 100).toFixed(1)}% free` 
      : 'N/A'
  };
}

function getErrorEventStats(event, error) {
  return {
    ...event.toObject(),
    statistics: {
      totalReservations: 'Error',
      totalTickets: 'Error',
      totalRevenue: 'Error',
      freeReservations: 'Error',
      paidReservations: 'Error',
      avgTicketsPerReservation: 'Error',
      occupancyRate: 'Error'
    },
    freeTicketsAvailable: 'Error',
    freeTicketsConsumed: 'Error',
    hasFreeTickets: false,
    performance: {
      isFreeEvent: event.price === 0,
      hasPaidTickets: 'Error',
      revenuePerTicket: 'Error'
    },
    error: error.message
  };
}

// GET /api/reports/events/{{eventId}}/all-reservations
router.get('/events/:eventId/all-reservations', async (req, res) => {
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
    
    // Obtener TODAS las reservas del evento
    const reservations = await Reservation.find({ eventId })
      .sort({ reservationDate: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    // Enriquecer datos con información de tipo y valor
    const enrichedReservations = reservations.map(reservation => {
      const totalTickets = reservation.tickets.length;
      const isFree = reservation.totalAmount === 0;
      const ticketValue = isFree ? 0 : (reservation.totalAmount / totalTickets);
      
      return {
        ...reservation.toObject(),
        reservationType: isFree ? 'free' : 'paid',
        totalTickets,
        ticketValue,
        // Agrupar por nombre para contar duplicados del mismo nombre
        ticketsByPerson: groupTicketsByName(reservation.tickets)
      };
    });
    
    const totalReservations = await Reservation.countDocuments({ eventId });
    
    res.json({
      event: {
        _id: event._id,
        title: event.title,
        date: event.date,
        location: event.location,
        price: event.price
      },
      reservations: enrichedReservations,
      totalPages: Math.ceil(totalReservations / parseInt(limit)),
      currentPage: parseInt(page),
      total: totalReservations
    });
    
  } catch (error) {
    console.error('Error obteniendo reservas:', error);
    res.status(500).json({ 
      message: 'Error al obtener las reservas',
      error: error.message
    });
  }
});

// Función para agrupar tickets por misma persona
function groupTicketsByName(tickets) {
  const grouped = {};
  
  tickets.forEach(ticket => {
    const key = `${ticket.nombre}-${ticket.apellido}`.toLowerCase();
    if (!grouped[key]) {
      grouped[key] = {
        nombre: ticket.nombre,
        apellido: ticket.apellido,
        telefono: ticket.telefono,
        email: ticket.email,
        count: 0
      };
    }
    grouped[key].count++;
  });
  
  return Object.values(grouped);
}


  //GET /api/reports/events/{{eventId}}/complete-stats
router.get('/events/:eventId/complete-stats', async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // Validar ObjectId
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    // Estadísticas de reservas
    const stats = await Reservation.aggregate([
      { $match: { eventId: new mongoose.Types.ObjectId(eventId) } },
      {
        $group: {
          _id: null,
          totalReservations: { $sum: 1 },
          totalTickets: { $sum: { $size: '$tickets' } },
          totalRevenue: { $sum: '$totalAmount' },
          freeReservations: {
            $sum: { $cond: [{ $eq: ['$totalAmount', 0] }, 1, 0] }
          },
          paidReservations: {
            $sum: { $cond: [{ $gt: ['$totalAmount', 0] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Tickets por persona (agrupados)
    const reservations = await Reservation.find({ eventId });
    const allTickets = reservations.flatMap(r => r.tickets);
    
    const ticketsByPerson = allTickets.reduce((acc, ticket) => {
      const key = `${ticket.nombre}-${ticket.apellido}`.toLowerCase();
      if (!acc[key]) {
        acc[key] = {
          nombre: ticket.nombre,
          apellido: ticket.apellido,
          count: 0,
          type: 'free' // Asumir free por defecto, ajustar según lógica de negocio
        };
      }
      acc[key].count++;
      return acc;
    }, {});
    
    res.json({
      event: {
        title: event.title,
        date: event.date,
        location: event.location,
        price: event.price,
        freeTickets: event.freeTickets
      },
      statistics: stats[0] || {
        totalReservations: 0,
        totalTickets: 0,
        totalRevenue: 0,
        freeReservations: 0,
        paidReservations: 0
      },
      ticketsByPerson: Object.values(ticketsByPerson),
      summary: {
        averageTicketsPerPerson: calculateAverage(ticketsByPerson),
        mostTicketsByOnePerson: findMaxTickets(ticketsByPerson)
      }
    });
    
  } catch (error) {
    console.error('Error en estadísticas:', error);
    res.status(500).json({ message: 'Error al obtener estadísticas' });
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