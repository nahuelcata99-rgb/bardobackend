
const mongoose = require('mongoose');
const Event = require('../models/Event');
require('dotenv').config();

const updateEventStatuses = async () => {
  try {
    // Verificar si ya estamos conectados
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Conectado a MongoDB para actualización de estados');
    }
    
    console.log('Actualizando estados de eventos...');
    await Event.updateEventStatuses();
    
    console.log('Estados actualizados exitosamente');
    return { success: true };
  } catch (error) {
    console.error('Error actualizando estados:', error);
    return { success: false, error: error.message };
  }
};

// Solo ejecutar directamente si se llama desde la línea de comandos
if (require.main === module) {
  updateEventStatuses()
    .then(result => {
      if (result.success) {
        console.log('Actualización completada');
        process.exit(0);
      } else {
        console.error('Error en actualización:', result.error);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Error fatal:', error);
      process.exit(1);
    });
}

module.exports = updateEventStatuses;