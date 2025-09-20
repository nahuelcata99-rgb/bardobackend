const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'El título del evento es requerido'],
    trim: true,
    minlength: [5, 'El título debe tener al menos 5 caracteres'],
    maxlength: [100, 'El título no puede exceder los 100 caracteres']
  },
  date: {
    type: Date,
    required: [true, 'La fecha del evento es requerida'],
    validate: {
      validator: function(value) {
        // La fecha del evento no puede ser en el pasado
        return value >= new Date();
      },
      message: 'La fecha del evento no puede ser en el pasado'
    }
  },
  location: {
    type: String,
    required: [true, 'La ubicación del evento es requerida'],
    trim: true,
    minlength: [5, 'La ubicación debe tener al menos 5 caracteres'],
    maxlength: [200, 'La ubicación no puede exceder los 200 caracteres']
  },
  dj: {
    type: String,
    trim: true,
    maxlength: [500, 'La lista de DJs no puede exceder los 500 caracteres']
  },
  info: {
    type: String,
    trim: true,
    maxlength: [1000, 'La información no puede exceder los 1000 caracteres']
  },
  price: {
    type: Number,
    min: [0, 'El precio no puede ser negativo'],
    default: 0
  },
  cancellationReason: {
    type: String,
    trim: true,
    maxlength: [500, 'La razón de cancelación no puede exceder los 500 caracteres']
  },
  cancelledAt: {
    type: Date
  },
  image: {
    type: String,
    required: [true, 'La imagen del evento es requerida'],
    validate: {
      validator: function(value) {
        // Validar que sea Base64 o URL válida
        return value.startsWith('data:image/') || 
               value.startsWith('http://') || 
               value.startsWith('https://');
      },
      message: 'La imagen debe ser en formato Base64 o URL válida'
    }
  },
  // Control de entradas gratis (ahora permitido en eventos pagos)
  freeTickets: {
    type: Number,
    min: [0, 'Las entradas gratis no pueden ser negativas'],
    default: 0, // 0 significa entradas ilimitadas
    validate: {
      validator: function(value) {
        // Solo validar que no sea negativo
        return value >= 0;
      },
      message: 'Las entradas gratis no pueden ser negativas'
    }
  },
  status: {
    type: String,
    enum: {
      values: ['active', 'cancelled', 'completed', 'sold-out', 'free-sold-out'],
      message: 'El estado debe ser: active, cancelled, completed, sold-out o free-sold-out'
    },
    default: 'active'
  },
  tags: {
    type: [String],
    validate: {
      validator: function(value) {
        // Máximo 10 tags por evento
        return value.length <= 10;
      },
      message: 'No se pueden agregar más de 10 tags'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  // Opciones del schema
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para mejor performance
eventSchema.index({ date: 1 });
eventSchema.index({ status: 1 });
eventSchema.index({ location: 'text', title: 'text' });

// Virtual para verificar si el evento es upcoming
eventSchema.virtual('isUpcoming').get(function() {
  return this.date > new Date();
});

// Virtual para verificar si el evento es pasado
eventSchema.virtual('isPast').get(function() {
  return this.date < new Date();
});

// Virtual para verificar si el evento está cancelado
eventSchema.virtual('isCancelled').get(function() {
  return this.status === 'cancelled';
});

// Virtual para verificar si el evento está completado
eventSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

// Virtual para verificar si tiene entradas gratis ilimitadas
eventSchema.virtual('hasUnlimitedFreeTickets').get(function() {
  return this.freeTickets === 0;
});

// Virtual para verificar si tiene entradas gratis limitadas
eventSchema.virtual('hasLimitedFreeTickets').get(function() {
  return this.freeTickets > 0;
});

// Virtual para verificar si el evento es completamente gratis
eventSchema.virtual('isCompletelyFree').get(function() {
  return this.price === 0;
});

// Virtual para formatear la fecha
eventSchema.virtual('formattedDate').get(function() {
  return this.date.toLocaleDateString('es-ES', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
});

// Virtual para mostrar información de entradas
eventSchema.virtual('ticketInfo').get(function() {
  if (this.price > 0) {
    if (this.freeTickets === 0) {
      return `Entrada: $${this.price}`;
    } else {
      return `Entrada: $${this.price} | ${this.freeTickets} entradas gratis disponibles`;
    }
  } else {
    if (this.freeTickets === 0) {
      return 'Entrada gratis (ilimitadas)';
    } else {
      return `Entrada gratis (${this.freeTickets} disponibles)`;
    }
  }
});

// Middleware para verificar estado antes de guardar
eventSchema.pre('save', function(next) {
  const now = new Date();
  
  // Si la fecha ya pasó, marcar como completed
  if (this.date < now && this.status === 'active') {
    this.status = 'completed';
  }
  
  // Si no hay free tickets y es evento gratis, marcar como sold-out
  if (this.freeTickets === 0 && this.price === 0 && this.status === 'active') {
    this.status = 'sold-out';
  }
  
  this.updatedAt = now;
  next();
});

// Método estático para actualizar estados automáticamente
eventSchema.statics.updateEventStatuses = async function() {
  const now = new Date();
  
  // Marcar eventos pasados como completed
  await this.updateMany(
    {
      date: { $lt: now },
      status: 'active'
    },
    {
      status: 'completed',
      updatedAt: now
    }
  );
  
  // Marcar eventos con free tickets agotados
  await this.updateMany(
    {
      freeTickets: 0,
      price: 0,
      status: 'active'
    },
    {
      status: 'sold-out',
      updatedAt: now
    }
  );
  
  console.log('Estados de eventos actualizados automáticamente');
};

// Método estático para obtener eventos próximos
eventSchema.statics.getUpcomingEvents = function(limit = 10) {
  return this.find({ 
    date: { $gte: new Date() },
    status: 'active'
  })
  .sort({ date: 1 })
  .limit(limit);
};

// Método estático para buscar eventos por término
eventSchema.statics.searchEvents = function(searchTerm, limit = 10) {
  return this.find({
    $text: { $search: searchTerm },
    status: 'active'
  })
  .limit(limit);
};

// Método estáticopara obtener eventos gratis
eventSchema.statics.getFreeEvents = function(limit = 10) {
  return this.find({
    price: 0,
    status: 'active',
    date: { $gte: new Date() }
  })
  .sort({ date: 1 })
  .limit(limit);
};

// Método estático para obtener eventos con entradas gratis disponibles
eventSchema.statics.getEventsWithFreeTickets = function(limit = 10) {
  return this.find({
    $or: [
      { price: 0 }, // Eventos completamente gratis
      { freeTickets: { $gt: 0 } } // Eventos pagos con entradas gratis disponibles
    ],
    status: 'active',
    date: { $gte: new Date() }
  })
  .sort({ date: 1 })
  .limit(limit);
};

// Método de instancia para verificar disponibilidad de entradas gratis
eventSchema.methods.checkFreeTicketAvailability = function() {
  if (this.freeTickets === 0) {
    return { 
      available: true, 
      message: this.price > 0 ? 
        'Entradas de pago disponibles' : 
        'Entradas gratis ilimitadas disponibles',
      unlimited: true,
      isFree: this.price === 0
    };
  }
  
  // Aquí podrías integrar con el modelo de Reservas para verificar cuántas entradas se han reservado
  return { 
    available: true, 
    message: `Entradas gratis disponibles: ${this.freeTickets}`,
    remaining: this.freeTickets,
    unlimited: false,
    isFree: this.price === 0
  };
};

// Método de instancia para reservar una entrada gratis
eventSchema.methods.reserveFreeTicket = function() {
  if (this.freeTickets > 0) {
    this.freeTickets -= 1;
    
    // Verificar si se agotaron las entradas gratis
    if (this.freeTickets === 0 && this.price === 0) {
      this.status = 'sold-out';
    } else if (this.freeTickets === 0 && this.price > 0) {
      this.status = 'free-sold-out'; // Solo se agotaron las entradas gratis
    }
    
    return this.save();
  }
  
  // Si freeTickets es 0, no se pueden reservar más entradas gratis
  throw new Error('No hay entradas gratis disponibles');
};

// Método de instancia para comprar entrada paga
eventSchema.methods.buyPaidTicket = function() {
  if (this.price === 0) {
    throw new Error('Este evento es gratis, no se pueden comprar entradas');
  }
  
  // Lógica para procesar pago (aquí iría la integración con tu sistema de pagos)
  return Promise.resolve(this);
};

// Método de instancia para cancelar evento
eventSchema.methods.cancelEvent = function(reason) {
  this.status = 'cancelled';
  if (reason) {
    this.cancellationReason = reason;
  }
  this.cancelledAt = new Date();
  return this.save();
};

// Método de instancia para actualizar entradas gratis
eventSchema.methods.updateFreeTickets = function(newAmount) {
  if (newAmount < 0) {
    throw new Error('La cantidad de entradas no puede ser negativa');
  }
  
  this.freeTickets = newAmount;
  
  // Actualizar estado según disponibilidad
  if (newAmount > 0) {
    if (this.status === 'sold-out' && this.price === 0) {
      this.status = 'active';
    } else if (this.status === 'free-sold-out' && this.price > 0) {
      this.status = 'active';
    }
  } else if (newAmount === 0) {
    if (this.price === 0 && this.status === 'active') {
      this.status = 'sold-out';
    } else if (this.price > 0 && this.status === 'active') {
      this.status = 'free-sold-out';
    }
  }
  
  return this.save();
};

module.exports = mongoose.model('Event', eventSchema);