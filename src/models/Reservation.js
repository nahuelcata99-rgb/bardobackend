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
    max: 4
  },
  reservationDate: {
    type: Date,
    default: Date.now
  },
  reservationCode: {
    type: String
  },
  status: {
    type: String,
    enum: ['confirmed', 'cancelled'],
    default: 'confirmed'
  },
  // Campos para el nuevo sistema
  preSaleStageIndex: {
    type: Number,
    default: null
  },
  isFreeTicket: {
    type: Boolean,
    default: false
  },
  // Campos de pago
  orderId: {
    type: String,
    index: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled', 'refunded'],
    default: 'pending'
  },
  paymentStatusDetail: {
    type: String
  },
  paymentMethod: {
    type: String,
    enum: ['mercadopago', 'free', 'other'],
    default: 'free'
  },
  paymentId: {
    type: String
  },
  totalAmount: {
    type: Number,
    default: 0
  },
  isPaid: {
    type: Boolean,
    default: false
  },
  paidAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Índices
reservationSchema.index({ reservationCode: 1 }, { unique: true });
reservationSchema.index({ eventId: 1, reservationDate: -1 });
reservationSchema.index({ 'tickets.email': 1 });
reservationSchema.index({ preSaleStageIndex: 1 });
reservationSchema.index({ isFreeTicket: 1 });

// Middleware pre-save
reservationSchema.pre('save', async function(next) {
  if (!this.reservationCode) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    this.reservationCode = `BARDO${timestamp}${random}`.toUpperCase();
  }
  
  if (this.isModified('paymentStatus') && this.paymentStatus === 'approved' && !this.paidAt) {
    this.paidAt = new Date();
    this.isPaid = true;
  }
  
  next();
});

module.exports = mongoose.model('Reservation', reservationSchema);