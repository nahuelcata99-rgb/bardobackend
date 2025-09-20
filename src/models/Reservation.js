const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
    trim: true
  },
  apellido: {
    type: String,
    required: true,
    trim: true
  },
  telefono: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  }
});

const reservationSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  eventTitle: {
    type: String,
    required: true,
    trim: true
  },
  tickets: [ticketSchema],
  totalTickets: {
    type: Number,
    required: true,
    min: 1,
    max: 4 // Máximo 4 tickets por reserva
  },
  reservationDate: {
    type: Date,
    default: Date.now
  },
  reservationCode: {
    type: String
    // REMOVER: unique: true - se define abajo con schema.index()
  },
  status: {
    type: String,
    enum: ['confirmed', 'cancelled'],
    default: 'confirmed'
  }
});

// Generar código de reserva automáticamente antes de guardar
reservationSchema.pre('save', async function(next) {
  if (!this.reservationCode) {
    // Generar código único: BARDO + timestamp + random
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    this.reservationCode = `BARDO${timestamp}${random}`.toUpperCase();
  }
  next();
});

// Índices para mejor performance - CORREGIDO
reservationSchema.index({ reservationCode: 1 }, { unique: true }); // Índice único
reservationSchema.index({ eventId: 1, reservationDate: -1 });
reservationSchema.index({ 'tickets.email': 1 });

module.exports = mongoose.model('Reservation', reservationSchema);