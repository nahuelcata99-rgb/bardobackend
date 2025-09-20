const express = require('express');
const router = express.Router();
const Reservation = require('../models/Reservation');
const Event = require('../models/Event');

// POST /api/reservations - Crear una nueva reserva
router.post('/', async (req, res) => {
  try {
    const { eventId, eventTitle, tickets } = req.body;
    
    // Validar campos requeridos
    if (!eventId || !eventTitle || !tickets || !Array.isArray(tickets)) {
      return res.status(400).json({ 
        message: 'Faltan campos requeridos: eventId, eventTitle, tickets' 
      });
    }
    
    // Validar que el evento exista
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    // Validar número de tickets (máximo 4)
    if (tickets.length === 0 || tickets.length > 4) {
      return res.status(400).json({ 
        message: 'Debe reservar entre 1 y 4 entradas' 
      });
    }
    
    // Validar que cada ticket tenga nombre y apellido
    for (const [index, ticket] of tickets.entries()) {
      if (!ticket.nombre || !ticket.apellido) {
        return res.status(400).json({ 
          message: `El ticket ${index + 1} debe tener nombre y apellido` 
        });
      }
      
      // Validar formato de email si se proporciona
      if (ticket.email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(ticket.email)) {
          return res.status(400).json({ 
            message: `El email del ticket ${index + 1} no es válido` 
          });
        }
      }
    }
    
    // Crear la nueva reserva
    const newReservation = new Reservation({
      eventId,
      eventTitle,
      tickets,
      totalTickets: tickets.length
    });
    
    const savedReservation = await newReservation.save();
    
    // Aquí podrías integrar con un servicio de email
    // await sendConfirmationEmail(savedReservation);
    
    res.status(201).json({
      message: 'Reserva creada exitosamente',
      reservation: savedReservation,
      reservationCode: savedReservation.reservationCode
    });
    
  } catch (error) {
    console.error('Error creating reservation:', error);
    
    // Manejar error de duplicación de código de reserva
    if (error.code === 11000) {
      return res.status(500).json({ 
        message: 'Error al generar código de reserva único. Intente nuevamente.' 
      });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reservations - Obtener todas las reservas (para admin)
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, eventId } = req.query;
    
    const query = {};
    if (eventId) {
      query.eventId = eventId;
    }
    
    const reservations = await Reservation.find(query)
      .sort({ reservationDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Reservation.countDocuments(query);
    
    res.json({
      reservations,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reservations/event/:eventId - Obtener reservas por evento
router.get('/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    const reservations = await Reservation.find({ eventId })
      .sort({ reservationDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Reservation.countDocuments({ eventId });
    const totalTickets = await Reservation.aggregate([
      { $match: { eventId: mongoose.Types.ObjectId(eventId) } },
      { $group: { _id: null, total: { $sum: '$totalTickets' } } }
    ]);
    
    res.json({
      reservations,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      totalReservations: total,
      totalTickets: totalTickets[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reservations/:code - Obtener reserva por código
router.get('/:code', async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ 
      reservationCode: req.params.code 
    });
    
    if (!reservation) {
      return res.status(404).json({ message: 'Reserva no encontrada' });
    }
    
    res.json(reservation);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// DELETE /api/reservations/:code - Cancelar reserva
router.delete('/:code', async (req, res) => {
  try {
    const reservation = await Reservation.findOne({ 
      reservationCode: req.params.code 
    });
    
    if (!reservation) {
      return res.status(404).json({ message: 'Reserva no encontrada' });
    }
    
    // Marcar como cancelada en lugar de eliminar
    reservation.status = 'cancelled';
    await reservation.save();
    
    res.json({ 
      message: 'Reserva cancelada exitosamente',
      reservation 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/reservations/stats/overview - Estadísticas de reservas
router.get('/stats/overview', async (req, res) => {
  try {
    const totalReservations = await Reservation.countDocuments();
    const totalTickets = await Reservation.aggregate([
      { $group: { _id: null, total: { $sum: '$totalTickets' } } }
    ]);
    
    const reservationsByEvent = await Reservation.aggregate([
      {
        $group: {
          _id: '$eventId',
          eventTitle: { $first: '$eventTitle' },
          reservationCount: { $sum: 1 },
          ticketCount: { $sum: '$totalTickets' }
        }
      },
      { $sort: { ticketCount: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      totalReservations,
      totalTickets: totalTickets[0]?.total || 0,
      reservationsByEvent
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;