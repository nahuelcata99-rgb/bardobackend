const mongoose = require('mongoose');

// Schema para las etapas de preventa
const preSaleStageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre de la etapa es requerido'],
    trim: true,
    maxlength: [50, 'El nombre no puede exceder los 50 caracteres']
  },
  price: {
    type: Number,
    required: [true, 'El precio de la etapa es requerido'],
    min: [0, 'El precio no puede ser negativo']
  },
  ticketLimit: {
    type: Number,
    required: [true, 'El límite de entradas es requerido'],
    min: [1, 'Debe haber al menos 1 entrada disponible']
  },
  ticketsSold: {
    type: Number,
    default: 0,
    min: [0, 'Las entradas vendidas no pueden ser negativas']
  },
  endDate: {
    type: Date,
    required: [true, 'La fecha de finalización es requerida'],
    validate: {
      validator: function(value) {
        return value > new Date();
      },
      message: 'La fecha de finalización debe ser futura'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  description: {
    type: String,
    maxlength: [200, 'La descripción no puede exceder los 200 caracteres']
  }
});

// Schema para entradas gratis
const freeTicketsConfigSchema = new mongoose.Schema({
  enabled: {
    type: Boolean,
    default: false
  },
  quantity: {
    type: Number,
    default: 0,
    min: [0, 'La cantidad no puede ser negativa']
  },
  ticketsClaimed: {
    type: Number,
    default: 0,
    min: [0, 'Las entradas reclamadas no pueden ser negativas']
  },
  description: {
    type: String,
    maxlength: [200, 'La descripción no puede exceder los 200 caracteres']
  }
});

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
  // Precio base (para eventos sin preventa)
  basePrice: {
    type: Number,
    min: [0, 'El precio base no puede ser negativo'],
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
        return value.startsWith('data:image/') || 
               value.startsWith('http://') || 
               value.startsWith('https://');
      },
      message: 'La imagen debe ser en formato Base64 o URL válida'
    }
  },
  // Nuevo sistema de preventas por etapas
  preSaleStages: [preSaleStageSchema],
  
  // Nuevo sistema de entradas gratis
  freeTickets: freeTicketsConfigSchema,
  
  status: {
    type: String,
    enum: {
      values: ['active', 'cancelled', 'completed', 'sold-out'],
      message: 'El estado debe ser: active, cancelled, completed, o sold-out'
    },
    default: 'active'
  },
  tags: {
    type: [String],
    validate: {
      validator: function(value) {
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
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para mejor performance
eventSchema.index({ date: 1 });
eventSchema.index({ status: 1 });
eventSchema.index({ location: 'text', title: 'text' });
eventSchema.index({ 'preSaleStages.endDate': 1 });
eventSchema.index({ 'preSaleStages.isActive': 1 });

// Virtuals
eventSchema.virtual('isUpcoming').get(function() {
  return this.date > new Date();
});

eventSchema.virtual('isPast').get(function() {
  return this.date < new Date();
});

eventSchema.virtual('isCancelled').get(function() {
  return this.status === 'cancelled';
});

eventSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

eventSchema.virtual('hasFreeTickets').get(function() {
  return this.freeTickets.enabled && (this.freeTickets.quantity === 0 || this.freeTickets.ticketsClaimed < this.freeTickets.quantity);
});

eventSchema.virtual('freeTicketsAvailable').get(function() {
  if (!this.freeTickets.enabled) return 0;
  if (this.freeTickets.quantity === 0) return Number.MAX_SAFE_INTEGER; // Ilimitadas
  return this.freeTickets.quantity - this.freeTickets.ticketsClaimed;
});

eventSchema.virtual('currentPreSaleStage').get(function() {
  const now = new Date();
  return this.preSaleStages
    .filter(stage => stage.isActive && stage.endDate > now)
    .sort((a, b) => a.endDate - b.endDate)[0]; // La etapa que termina primero
});

eventSchema.virtual('currentPrice').get(function() {
  const currentStage = this.currentPreSaleStage;
  if (currentStage) {
    return currentStage.price;
  }
  return this.basePrice;
});

eventSchema.virtual('totalTicketsAvailable').get(function() {
  let total = 0;
  this.preSaleStages.forEach(stage => {
    if (stage.isActive) {
      total += (stage.ticketLimit - stage.ticketsSold);
    }
  });
  return total;
});

// Middleware para verificar estado antes de guardar
eventSchema.pre('save', function(next) {
  const now = new Date();
  
  // Si la fecha ya pasó, marcar como completed
  if (this.date < now && this.status === 'active') {
    this.status = 'completed';
  }
  
  // Verificar si se agotaron las entradas
  if (this.status === 'active' && this.totalTicketsAvailable === 0) {
    this.status = 'sold-out';
  }
  
  // Actualizar etapas de preventa
  this.preSaleStages.forEach(stage => {
    if (stage.endDate < now) {
      stage.isActive = false;
    }
  });
  
  this.updatedAt = now;
  next();
});

// Método para obtener la etapa de preventa actual
eventSchema.methods.getCurrentStage = function() {
  return this.currentPreSaleStage;
};

// Método para comprar entradas de preventa
eventSchema.methods.buyPreSaleTickets = function(stageIndex, quantity) {
  if (stageIndex >= this.preSaleStages.length) {
    throw new Error('Etapa de preventa no válida');
  }
  
  const stage = this.preSaleStages[stageIndex];
  
  if (!stage.isActive) {
    throw new Error('Esta etapa de preventa no está activa');
  }
  
  if (stage.endDate < new Date()) {
    throw new Error('Esta etapa de preventa ha expirado');
  }
  
  if (stage.ticketsSold + quantity > stage.ticketLimit) {
    throw new Error('No hay suficientes entradas disponibles en esta etapa');
  }
  
  stage.ticketsSold += quantity;
  return this.save();
};

// Método para reclamar entradas gratis
eventSchema.methods.claimFreeTicket = function(quantity = 1) {
  if (!this.freeTickets.enabled) {
    throw new Error('Este evento no tiene entradas gratis disponibles');
  }
  
  if (this.freeTickets.quantity > 0) {
    if (this.freeTickets.ticketsClaimed + quantity > this.freeTickets.quantity) {
      throw new Error('No hay suficientes entradas gratis disponibles');
    }
    this.freeTickets.ticketsClaimed += quantity;
  }
  
  return this.save();
};

// Método para agregar una nueva etapa de preventa
eventSchema.methods.addPreSaleStage = function(stageData) {
  this.preSaleStages.push(stageData);
  return this.save();
};

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
  
  // Desactivar etapas de preventa expiradas
  const events = await this.find({
    'preSaleStages.endDate': { $lt: now },
    'preSaleStages.isActive': true
  });
  
  for (const event of events) {
    event.preSaleStages.forEach(stage => {
      if (stage.endDate < now) {
        stage.isActive = false;
      }
    });
    await event.save();
  }
  
  console.log('Estados de eventos y preventas actualizados automáticamente');
};

module.exports = mongoose.model('Event', eventSchema);