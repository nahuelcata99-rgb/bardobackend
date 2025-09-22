require('dotenv').config();
const mongoose = require('mongoose');
const Event = require('./models/Event');

const testConnection = async () => {
  try {
    // Conectar a la base de datos
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB Atlas');

    // Crear un documento de prueba
    const testEvent = new Event({
      title: "Evento de Prueba",
      date: new Date('2023-12-15T22:00:00.000Z'),
      location: "Lugar de Prueba",
      dj: "DJ Prueba",
      info: "Este es un evento de prueba para verificar la conexión",
      price: 25,
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    });

    // Guardar el documento
    const savedEvent = await testEvent.save();
    console.log('✅ Evento de prueba guardado correctamente');
    console.log('ID del evento:', savedEvent._id);

    // Buscar el documento para verificar
    const foundEvent = await Event.findById(savedEvent._id);
    console.log('✅ Evento recuperado de la base de datos');
    console.log('Título:', foundEvent.title);

    // Eliminar el documento de prueba
    await Event.findByIdAndDelete(savedEvent._id);
    console.log('✅ Evento de prueba eliminado');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    // Cerrar la conexión
    await mongoose.connection.close();
    console.log('✅ Conexión cerrada');
  }
};

testConnection();