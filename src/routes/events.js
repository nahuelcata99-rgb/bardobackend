const express = require('express');
const Event = require('../models/Event');
const router = express.Router();

// GET /api/events - Obtener todos los eventos con filtros
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, upcoming, past, search, status } = req.query;
    
    let query = {};
    
    if (upcoming === 'true') {
      query.date = { $gte: new Date() };
      query.status = 'active';
    } else if (past === 'true') {
      query.date = { $lt: new Date() };
    }
    
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { dj: { $regex: search, $options: 'i' } }
      ];
    }
    
    const events = await Event.find(query)
      .sort({ date: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Event.countDocuments(query);
    
    res.json({
      events,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/events/:id - Obtener un evento por ID
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    res.json(event);
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// GET /api/events/stats/overview - Obtener estadísticas de eventos
router.get('/stats/overview', async (req, res) => {
  try {
    const totalEvents = await Event.countDocuments();
    const upcomingEvents = await Event.countDocuments({ 
      date: { $gte: new Date() } 
    });
    const pastEvents = await Event.countDocuments({ 
      date: { $lt: new Date() } 
    });
    
    // Eventos próximos (próximos 7 días)
    const nextWeekEvents = await Event.countDocuments({
      date: { 
        $gte: new Date(),
        $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });
    
    res.json({
      totalEvents,
      upcomingEvents,
      pastEvents,
      nextWeekEvents
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// GET /api/events/upcoming/next - Próximos eventos (para dashboard)
router.get('/upcoming/next', async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    
    const upcomingEvents = await Event.find({
      date: { $gte: new Date() }
    })
    .sort({ date: 1 })
    .limit(parseInt(limit));
    
    res.json(upcomingEvents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// POST /api/events - Crear un nuevo evento
router.post('/', async (req, res) => {
  try {
    const { 
      title, 
      date, 
      location, 
      dj, 
      info, 
      basePrice, 
      image, 
      preSaleStages, 
      freeTickets 
    } = req.body;
    
    // Validar campos requeridos
    if (!title || !date || !location || !image) {
      return res.status(400).json({ 
        message: 'Faltan campos requeridos: título, fecha, ubicación o imagen' 
      });
    }
    
    // Validaciones existentes...
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ 
        message: 'Formato de imagen no válido. Use Base64.' 
      });
    }
    
    const matches = image.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ 
        message: 'Formato Base64 incorrecto' 
      });
    }
    
    const eventDate = new Date(date);
    if (eventDate < new Date()) {
      return res.status(400).json({ 
        message: 'La fecha del evento no puede ser en el pasado' 
      });
    }
    
    if (basePrice && basePrice < 0) {
      return res.status(400).json({ 
        message: 'El precio base debe ser un valor positivo' 
      });
    }
    
    // Validar etapas de preventa si se proporcionan
    if (preSaleStages && Array.isArray(preSaleStages)) {
      for (const [index, stage] of preSaleStages.entries()) {
        if (!stage.name || !stage.price || !stage.ticketLimit || !stage.endDate) {
          return res.status(400).json({ 
            message: `Faltan campos en la etapa ${index + 1}: nombre, precio, límite de entradas o fecha de fin` 
          });
        }
        
        if (stage.price < 0) {
          return res.status(400).json({ 
            message: `El precio de la etapa ${index + 1} no puede ser negativo` 
          });
        }
        
        if (stage.ticketLimit < 1) {
          return res.status(400).json({ 
            message: `El límite de entradas de la etapa ${index + 1} debe ser al menos 1` 
          });
        }
        
        const stageEndDate = new Date(stage.endDate);
        if (stageEndDate <= new Date()) {
          return res.status(400).json({ 
            message: `La fecha de fin de la etapa ${index + 1} debe ser futura` 
          });
        }
      }
    }
    
    // Crear el nuevo evento
    const newEvent = new Event({
      title: title.trim(),
      date: eventDate,
      location: location.trim(),
      dj: dj ? dj.trim() : '',
      info: info ? info.trim() : '',
      basePrice: basePrice || 0,
      image,
      preSaleStages: preSaleStages || [],
      freeTickets: freeTickets || { enabled: false, quantity: 0 }
    });
    
    const savedEvent = await newEvent.save();
    
    res.status(201).json({
      message: 'Evento creado exitosamente',
      event: savedEvent
    });
    
  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ 
        message: 'Error de validación',
        errors 
      });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PUT /api/events/:id - Actualizar un evento
router.put('/:id', async (req, res) => {
  try {
    const { 
      title, 
      date, 
      location, 
      dj, 
      info, 
      basePrice, 
      image, 
      preSaleStages, 
      freeTickets 
    } = req.body;
    
    const existingEvent = await Event.findById(req.params.id);
    if (!existingEvent) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    // Validaciones existentes...
    if (image && !image.startsWith('data:image/')) {
      return res.status(400).json({ 
        message: 'Formato de imagen no válido. Use Base64.' 
      });
    }
    
    if (date) {
      const eventDate = new Date(date);
      if (eventDate < new Date()) {
        return res.status(400).json({ 
          message: 'La fecha del evento no puede ser en el pasado' 
        });
      }
    }
    
    if (basePrice && basePrice < 0) {
      return res.status(400).json({ 
        message: 'El precio base debe ser un valor positivo' 
      });
    }
    
    // Validar etapas de preventa si se proporcionan
    if (preSaleStages && Array.isArray(preSaleStages)) {
      for (const [index, stage] of preSaleStages.entries()) {
        if (!stage.name || !stage.price || !stage.ticketLimit || !stage.endDate) {
          return res.status(400).json({ 
            message: `Faltan campos en la etapa ${index + 1}: nombre, precio, límite de entradas o fecha de fin` 
          });
        }
        
        if (stage.price < 0) {
          return res.status(400).json({ 
            message: `El precio de la etapa ${index + 1} no puede ser negativo` 
          });
        }
        
        if (stage.ticketLimit < 1) {
          return res.status(400).json({ 
            message: `El límite de entradas de la etapa ${index + 1} debe ser al menos 1` 
          });
        }
        
        const stageEndDate = new Date(stage.endDate);
        if (stageEndDate <= new Date()) {
          return res.status(400).json({ 
            message: `La fecha de fin de la etapa ${index + 1} debe ser futura` 
          });
        }
      }
    }
    
    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      { 
        title: title ? title.trim() : existingEvent.title,
        date: date ? new Date(date) : existingEvent.date,
        location: location ? location.trim() : existingEvent.location,
        dj: dj !== undefined ? dj.trim() : existingEvent.dj,
        info: info !== undefined ? info.trim() : existingEvent.info,
        basePrice: basePrice !== undefined ? basePrice : existingEvent.basePrice,
        image: image || existingEvent.image,
        preSaleStages: preSaleStages !== undefined ? preSaleStages : existingEvent.preSaleStages,
        freeTickets: freeTickets !== undefined ? freeTickets : existingEvent.freeTickets
      },
      { new: true, runValidators: true }
    );
    
    res.json({
      message: 'Evento actualizado exitosamente',
      event: updatedEvent
    });
    
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ 
        message: 'Error de validación',
        errors 
      });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/events/:id/pre-sale/stage - Agregar etapa de preventa
router.patch('/:id/pre-sale/stage', async (req, res) => {
  try {
    const { name, price, ticketLimit, endDate, description } = req.body;
    
    if (!name || !price || !ticketLimit || !endDate) {
      return res.status(400).json({ 
        message: 'Faltan campos requeridos: nombre, precio, límite de entradas o fecha de fin' 
      });
    }
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    const stageEndDate = new Date(endDate);
    if (stageEndDate <= new Date()) {
      return res.status(400).json({ 
        message: 'La fecha de fin debe ser futura' 
      });
    }
    
    const newStage = {
      name: name.trim(),
      price: Number(price),
      ticketLimit: Number(ticketLimit),
      endDate: stageEndDate,
      description: description ? description.trim() : '',
      isActive: true,
      ticketsSold: 0
    };
    
    event.preSaleStages.push(newStage);
    await event.save();
    
    res.json({
      message: 'Etapa de preventa agregada exitosamente',
      event
    });
    
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/events/:id/pre-sale/stage/:stageIndex - Actualizar etapa de preventa
router.patch('/:id/pre-sale/stage/:stageIndex', async (req, res) => {
  try {
    const { stageIndex } = req.params;
    const updates = req.body;
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    if (stageIndex >= event.preSaleStages.length) {
      return res.status(400).json({ message: 'Índice de etapa no válido' });
    }
    
    const stage = event.preSaleStages[stageIndex];
    
    // Validar fecha si se está actualizando
    if (updates.endDate) {
      const newEndDate = new Date(updates.endDate);
      if (newEndDate <= new Date()) {
        return res.status(400).json({ 
          message: 'La nueva fecha de fin debe ser futura' 
        });
      }
      stage.endDate = newEndDate;
    }
    
    if (updates.name !== undefined) stage.name = updates.name.trim();
    if (updates.price !== undefined) stage.price = Number(updates.price);
    if (updates.ticketLimit !== undefined) stage.ticketLimit = Number(updates.ticketLimit);
    if (updates.description !== undefined) stage.description = updates.description.trim();
    if (updates.isActive !== undefined) stage.isActive = Boolean(updates.isActive);
    
    await event.save();
    
    res.json({
      message: 'Etapa de preventa actualizada exitosamente',
      event
    });
    
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/events/:id/free-tickets - Actualizar configuración de entradas gratis
router.patch('/:id/free-tickets', async (req, res) => {
  try {
    const { enabled, quantity, description } = req.body;
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    if (enabled !== undefined) event.freeTickets.enabled = Boolean(enabled);
    if (quantity !== undefined) event.freeTickets.quantity = Number(quantity);
    if (description !== undefined) event.freeTickets.description = description.trim();
    
    await event.save();
    
    res.json({
      message: 'Configuración de entradas gratis actualizada exitosamente',
      event
    });
    
  } catch (error) {
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/events/:id/status - Cambiar estado de evento
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, cancellationReason } = req.body;
    
    // Validar estado
    const validStatuses = ['active', 'cancelled', 'completed', 'sold-out', 'free-sold-out'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        message: 'Estado no válido. Use: active, cancelled, completed, sold-out, free-sold-out' 
      });
    }
    
    // Preparar update object
    const updateData = { status };
    
    // Si se cancela, agregar razón de cancelación
    if (status === 'cancelled' && cancellationReason) {
      updateData.cancellationReason = cancellationReason;
      updateData.cancelledAt = new Date();
    }
    
    // Si se reactiva, limpiar campos de cancelación
    if (status === 'active') {
      updateData.cancellationReason = undefined;
      updateData.cancelledAt = undefined;
    }
    
    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedEvent) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    res.json({
      message: `Evento marcado como ${status}`,
      event: updatedEvent
    });
    
  } catch (error) {
    // Manejar error si el ID no es válido
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});


// DELETE /api/events/:id - Eliminar un evento
router.delete('/:id', async (req, res) => {
  try {
    const deletedEvent = await Event.findByIdAndDelete(req.params.id);
    
    if (!deletedEvent) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    res.json({ 
      message: 'Evento eliminado correctamente',
      deletedEvent: {
        id: deletedEvent._id,
        title: deletedEvent.title
      }
    });
    
  } catch (error) {
    // Manejar error si el ID no es válido
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/events/:id/status - Cambiar estado de evento (opcional)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    
    // Validar estado
    if (!['active', 'cancelled', 'completed'].includes(status)) {
      return res.status(400).json({ 
        message: 'Estado no válido. Use: active, cancelled, o completed' 
      });
    }
    
    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    
    if (!updatedEvent) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    res.json({
      message: `Evento marcado como ${status}`,
      event: updatedEvent
    });
    
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;