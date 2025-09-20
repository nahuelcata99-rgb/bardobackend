const express = require('express');
const Event = require('../models/Event');
const router = express.Router();

// GET /api/events - Obtener todos los eventos con filtros
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10, upcoming, past, search, status } = req.query;
    
    // Construir query basado en los filtros
    let query = {};
    
    // Filtrar por eventos próximos o pasados
    if (upcoming === 'true') {
      query.date = { $gte: new Date() };
      query.status = 'active'; // Solo eventos activos para próximos
    } else if (past === 'true') {
      query.date = { $lt: new Date() };
      // Puede incluir completed y active que ya pasaron
    }
    
    // Filtrar por estado específico
    if (status && status !== 'all') {
      query.status = status;
    }
    
    // Búsqueda por título o ubicación
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
    // Manejar error si el ID no es válido
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
    const { title, date, location, dj, info, price, image } = req.body;
    
    // Validar campos requeridos
    if (!title || !date || !location || !image) {
      return res.status(400).json({ 
        message: 'Faltan campos requeridos: título, fecha, ubicación o imagen' 
      });
    }
    
    // Validar que tenemos una imagen en Base64
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ 
        message: 'Formato de imagen no válido. Use Base64.' 
      });
    }
    
    // Validar formato Base64
    const matches = image.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ 
        message: 'Formato Base64 incorrecto' 
      });
    }
    
    // Validar fecha (no puede ser en el pasado)
    const eventDate = new Date(date);
    if (eventDate < new Date()) {
      return res.status(400).json({ 
        message: 'La fecha del evento no puede ser en el pasado' 
      });
    }
    
    // Validar precio (debe ser positivo si se proporciona)
    if (price && price < 0) {
      return res.status(400).json({ 
        message: 'El precio debe ser un valor positivo' 
      });
    }
    
    // Crear el nuevo evento
    const newEvent = new Event({
      title: title.trim(),
      date: eventDate,
      location: location.trim(),
      dj: dj ? dj.trim() : '',
      info: info ? info.trim() : '',
      price: price || 0,
      image
    });
    
    const savedEvent = await newEvent.save();
    
    res.status(201).json({
      message: 'Evento creado exitosamente',
      event: savedEvent
    });
    
  } catch (error) {
    // Manejar errores de validación de Mongoose
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
    const { title, date, location, dj, info, price, image } = req.body;
    
    // Verificar si el evento existe
    const existingEvent = await Event.findById(req.params.id);
    if (!existingEvent) {
      return res.status(404).json({ message: 'Evento no encontrado' });
    }
    
    // Si se envía una imagen, validar que sea Base64 válido
    if (image && !image.startsWith('data:image/')) {
      return res.status(400).json({ 
        message: 'Formato de imagen no válido. Use Base64.' 
      });
    }
    
    // Validar fecha si se está actualizando
    if (date) {
      const eventDate = new Date(date);
      if (eventDate < new Date()) {
        return res.status(400).json({ 
          message: 'La fecha del evento no puede ser en el pasado' 
        });
      }
    }
    
    // Validar precio si se está actualizando
    if (price && price < 0) {
      return res.status(400).json({ 
        message: 'El precio debe ser un valor positivo' 
      });
    }
    
    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      { 
        title: title ? title.trim() : existingEvent.title,
        date: date ? new Date(date) : existingEvent.date,
        location: location ? location.trim() : existingEvent.location,
        dj: dj !== undefined ? dj.trim() : existingEvent.dj,
        info: info !== undefined ? info.trim() : existingEvent.info,
        price: price !== undefined ? price : existingEvent.price,
        image: image || existingEvent.image
      },
      { new: true, runValidators: true }
    );
    
    res.json({
      message: 'Evento actualizado exitosamente',
      event: updatedEvent
    });
    
  } catch (error) {
    // Manejar error si el ID no es válido
    if (error.kind === 'ObjectId') {
      return res.status(400).json({ message: 'ID de evento no válido' });
    }
    
    // Manejar errores de validación de Mongoose
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