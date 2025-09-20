const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

// Importar la conexión a la base de datos
const connectDB = require('./config/database');

// Import routes
const eventRoutes = require('./routes/events');
const reservationRoutes = require('./routes/reservations');
const reportsRoutes = require('./routes/reports');

// Importar el script de actualización de estados
const updateEventStatuses = require('./scripts/updateEventStatuses');

const app = express();

// Conectar a la base de datos
connectDB();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
app.use('/api/events', eventRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/reports', reportsRoutes);

// Manejo de errores global
app.use((error, req, res, next) => {
  console.error('Error global:', error);
  res.status(500).json({ 
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Ocurrió un error'
  });
});

// Ruta de prueba para verificar que el servidor funciona
app.get('/api/health', async (req, res) => {
  try {
    // Verificar conexión a MongoDB
    const mongoose = require('mongoose');
    const dbState = mongoose.connection.readyState;
    
    const health = {
      status: 'OK',
      timestamp: new Date(),
      database: dbState === 1 ? 'Connected' : 'Disconnected',
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime()
    };
    
    res.json(health);
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR',
      error: error.message 
    });
  }
});

const PORT = process.env.PORT || 5000;

// Iniciar servidor
const server = app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
  
  // Programar actualización diaria a medianoche - SOLO DESPUÉS de que el servidor esté listo
  cron.schedule('0 0 * * *', () => {
    console.log('Ejecutando actualización automática de estados de eventos...');
    updateEventStatuses();
  });
  
  // También ejecutar al iniciar el servidor - SOLO DESPUÉS de que el servidor esté listo
  console.log('Ejecutando actualización inicial de estados de eventos...');
  updateEventStatuses();
});

// Manejar cierre graceful del servidor
process.on('SIGINT', () => {
  console.log('Recibido SIGINT. Cerrando servidor gracefulmente...');
  server.close(() => {
    console.log('Servidor cerrado.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Recibido SIGTERM. Cerrando servidor gracefulmente...');
  server.close(() => {
    console.log('Servidor cerrado.');
    process.exit(0);
  });
});