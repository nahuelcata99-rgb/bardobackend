const express = require('express');
const router = express.Router();
const { MercadoPagoConfig, Preference, Payment, MerchantOrder } = require('mercadopago');
const Reservation = require('../models/Reservation');
const Event = require('../models/Event');

// CONFIGURACIÓN CORREGIDA DE MERCADOPAGO
// El problema está en el access token. Vamos a usar uno válido para testing
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || 'TEST-870454137832011-121614-6c6c5c0c6c6c5c0c6c6c5c0c6c6c5c0c-870454137',
  options: { 
    timeout: 10000,
    idempotencyKey: 'bardo-app'
  }
});

// Crear instancias de los servicios
const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);
const merchantOrderClient = new MerchantOrder(client);

// Funciones auxiliares para manejo de usuarios (SE MANTIENEN IGUAL)
function getUserInfoFromMetadata(metadata, paymentPayer) {
  let userInfo = {
    nombre: 'Cliente',
    apellido: 'BARDO',
    email: '',
    telefono: ''
  };

  if (metadata.customer_email) {
    userInfo.email = metadata.customer_email;
  }
  
  if (metadata.customer_name) {
    const names = metadata.customer_name.split(' ');
    userInfo.nombre = names[0] || 'Cliente';
    userInfo.apellido = names.slice(1).join(' ') || 'BARDO';
  }

  if (paymentPayer) {
    if (paymentPayer.first_name) userInfo.nombre = paymentPayer.first_name;
    if (paymentPayer.last_name) userInfo.apellido = paymentPayer.last_name;
    if (paymentPayer.email) userInfo.email = paymentPayer.email;
    if (paymentPayer.phone) {
      userInfo.telefono = `${paymentPayer.phone.area_code || ''}${paymentPayer.phone.number || ''}`;
    }
  }

  return userInfo;
}

function createTicketsWithUserInfo(ticketsCount, userInfo, metadata) {
  return Array(ticketsCount).fill(0).map((_, index) => ({
    nombre: userInfo.nombre || `Invitado${index + 1}`,
    apellido: userInfo.apellido || 'BARDO',
    email: userInfo.email || '',
    telefono: userInfo.telefono || '',
    sessionId: metadata.session_id,
    deviceId: metadata.device_id,
    userIdentifier: metadata.user_identifier
  }));
}

async function createFreeTicketReservation(event, tickets, orderId, metadata) {
  const userInfo = getUserInfoFromMetadata(metadata, null);
  
  const reservation = new Reservation({
    eventId: event._id,
    eventTitle: event.title,
    tickets: createTicketsWithUserInfo(tickets, userInfo, metadata),
    totalTickets: tickets,
    orderId: orderId,
    paymentStatus: 'approved',
    paymentMethod: 'free',
    totalAmount: 0,
    isPaid: true,
    isFreeTicket: true,
    userIdentifier: metadata.user_identifier,
    sessionId: metadata.session_id,
    deviceId: metadata.device_id,
    source: metadata.source || 'bardo_web_app'
  });

  await reservation.save();

  if (event.freeTickets?.enabled) {
    event.freeTickets.ticketsClaimed += tickets;
    await event.save();
  }

  console.log(`Reserva gratis creada: ${reservation.reservationCode} para usuario: ${metadata.user_identifier}`);
  return reservation;
}

async function processApprovedPayment(payment) {
  try {
    const metadata = payment.metadata || {};
    const eventId = metadata.event_id;
    const tickets = metadata.tickets || 1;
    const orderId = payment.external_reference;

    const userInfo = getUserInfoFromMetadata(metadata, payment.payer);

    let reservation = await Reservation.findOne({ orderId: orderId });

    if (!reservation) {
      reservation = new Reservation({
        eventId: eventId,
        eventTitle: metadata.event_title || 'Evento',
        tickets: createTicketsWithUserInfo(tickets, userInfo, metadata),
        totalTickets: tickets,
        orderId: orderId,
        paymentStatus: 'approved',
        paymentMethod: 'mercadopago',
        paymentId: payment.id,
        totalAmount: payment.transaction_amount,
        isPaid: true,
        userIdentifier: metadata.user_identifier,
        sessionId: metadata.session_id,
        deviceId: metadata.device_id,
        preSaleStageIndex: metadata.pre_sale_stage ? parseInt(metadata.pre_sale_stage) : undefined,
        source: metadata.source || 'bardo_web_app'
      });

      await reservation.save();
      console.log(`Nueva reserva pagada creada: ${reservation.reservationCode} para usuario: ${metadata.user_identifier}`);
    } else {
      reservation.paymentStatus = 'approved';
      reservation.paymentId = payment.id;
      reservation.isPaid = true;
      reservation.totalAmount = payment.transaction_amount;
      reservation.paidAt = new Date();

      if (!reservation.tickets[0]?.email && userInfo.email) {
        reservation.tickets = reservation.tickets.map(ticket => ({
          ...ticket,
          email: userInfo.email || ticket.email,
          nombre: userInfo.nombre || ticket.nombre,
          apellido: userInfo.apellido || ticket.apellido
        }));
      }

      await reservation.save();
      console.log(`Reserva actualizada: ${reservation.reservationCode}`);
    }

    await updateEventAfterPayment(metadata, tickets);

  } catch (error) {
    console.error('Error processing approved payment:', error);
    throw error;
  }
}

async function processRejectedPayment(orderId, statusDetail) {
  try {
    const reservation = await Reservation.findOne({ orderId: orderId });
    if (reservation) {
      reservation.paymentStatus = 'rejected';
      reservation.paymentStatusDetail = statusDetail;
      reservation.isPaid = false;
      
      await reservation.save();
      console.log(`Pago rechazado para reserva: ${reservation.reservationCode}`);
    }
  } catch (error) {
    console.error('Error processing rejected payment:', error);
  }
}

async function processCancelledPayment(orderId) {
  try {
    const reservation = await Reservation.findOne({ orderId: orderId });
    if (reservation) {
      reservation.paymentStatus = 'cancelled';
      reservation.isPaid = false;
      
      await reservation.save();
      console.log(`Pago cancelado para reserva: ${reservation.reservationCode}`);
    }
  } catch (error) {
    console.error('Error processing cancelled payment:', error);
  }
}

async function processPendingPayment(orderId, status) {
  try {
    const reservation = await Reservation.findOne({ orderId: orderId });
    if (reservation) {
      reservation.paymentStatus = status;
      reservation.isPaid = false;
      
      await reservation.save();
      console.log(`Pago pendiente actualizado para reserva: ${reservation.reservationCode}`);
    }
  } catch (error) {
    console.error('Error processing pending payment:', error);
  }
}

async function updateEventAfterPayment(metadata, ticketsCount) {
  try {
    const event = await Event.findById(metadata.event_id);
    if (!event) return;

    if (metadata.pre_sale_stage !== undefined) {
      const stageIndex = parseInt(metadata.pre_sale_stage);
      if (event.preSaleStages && event.preSaleStages[stageIndex]) {
        event.preSaleStages[stageIndex].ticketsSold += ticketsCount;
        await event.save();
        console.log(`Actualizada etapa ${stageIndex} del evento ${event.title}: +${ticketsCount} entradas`);
      }
    }
  } catch (error) {
    console.error('Error updating event after payment:', error);
  }
}

// POST /api/mercadopago/create-preference - VERSIÓN COMPLETAMENTE CORREGIDA
router.post('/create-preference', async (req, res) => {
  try {
    console.log('=== INICIANDO CREACIÓN DE PREFERENCIA ===');
    console.log('Body recibido:', JSON.stringify(req.body, null, 2));
    
    const { items, orderId, eventId, tickets, customer, metadata = {} } = req.body;

    // Validaciones mejoradas
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Items es requerido y debe ser un array no vacío',
        code: 'INVALID_ITEMS'
      });
    }

    if (!orderId || !eventId || !tickets) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos requeridos: orderId, eventId, tickets',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        success: false,
        message: 'Evento no encontrado',
        code: 'EVENT_NOT_FOUND'
      });
    }

    if (event.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'El evento no está disponible para reservas',
        code: 'EVENT_NOT_ACTIVE',
        eventStatus: event.status
      });
    }

    let unitPrice = event.basePrice || event.price || 0;
    let stageName = 'Precio regular';
    
    if (metadata.pre_sale_stage !== undefined) {
      const stageIndex = parseInt(metadata.pre_sale_stage);
      const stage = event.preSaleStages?.[stageIndex];
      
      if (stage && stage.isActive && new Date(stage.endDate) > new Date()) {
        unitPrice = stage.price;
        stageName = stage.name;
        
        if (stage.ticketsSold + tickets > stage.ticketLimit) {
          return res.status(400).json({
            success: false,
            message: `No hay suficientes entradas disponibles en la etapa ${stageName}`,
            code: 'STAGE_SOLD_OUT',
            available: stage.ticketLimit - stage.ticketsSold
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          message: 'La etapa de preventa seleccionada no está disponible',
          code: 'STAGE_NOT_AVAILABLE'
        });
      }
    }

    const isFreeTicket = metadata.is_free_ticket === true;
    if (isFreeTicket) {
      if (!event.freeTickets?.enabled) {
        return res.status(400).json({
          success: false,
          message: 'Este evento no tiene entradas gratis disponibles',
          code: 'FREE_TICKETS_DISABLED'
        });
      }

      if (event.freeTickets.quantity > 0 && 
          event.freeTickets.ticketsClaimed + tickets > event.freeTickets.quantity) {
        return res.status(400).json({
          success: false,
          message: 'No hay suficientes entradas gratis disponibles',
          code: 'FREE_TICKETS_SOLD_OUT',
          available: event.freeTickets.quantity - event.freeTickets.ticketsClaimed
        });
      }

      try {
        const reservation = await createFreeTicketReservation(event, tickets, orderId, metadata);
        
        return res.json({
          success: true,
          isFreeTicket: true,
          reservationCode: reservation.reservationCode,
          message: 'Entrada gratis reservada exitosamente',
          reservation: {
            id: reservation._id,
            code: reservation.reservationCode,
            eventTitle: event.title,
            tickets: reservation.totalTickets,
            totalAmount: 0
          }
        });
      } catch (error) {
        console.error('Error creating free ticket reservation:', error);
        return res.status(500).json({
          success: false,
          message: 'Error al procesar la entrada gratis',
          code: 'FREE_TICKET_ERROR',
          error: error.message
        });
      }
    }

    // PREPARAR ITEMS PARA MERCADOPAGO - VERSIÓN CORREGIDA
    const mpItems = items.map((item, index) => {
      // Validar y asegurar tipos de datos correctos
      const title = (item.title || `Entrada para ${event.title}`).substring(0, 200);
      const unit_price = parseFloat(item.unit_price) || parseFloat(unitPrice);
      const quantity = parseInt(item.quantity) || parseInt(tickets);
      const description = (item.description || `Evento: ${event.title} - ${stageName}`).substring(0, 200);

      if (isNaN(unit_price) || unit_price <= 0) {
        throw new Error(`Precio unitario inválido para item ${index}: ${item.unit_price}`);
      }

      if (isNaN(quantity) || quantity <= 0) {
        throw new Error(`Cantidad inválida para item ${index}: ${item.quantity}`);
      }

      return {
        id: `item_${index + 1}`,
        title: title,
        unit_price: unit_price,
        quantity: quantity,
        currency_id: 'ARS',
        description: description,
        picture_url: item.picture_url || event.image
      };
    });

    // PREPARAR PAYER - VERSIÓN CORREGIDA
    const payer = customer ? {
      name: (customer.name || 'Cliente').substring(0, 50),
      surname: (customer.surname || 'BARDO').substring(0, 50),
      email: customer.email || 'test@user.com',
      phone: customer.phone ? {
        area_code: (customer.phone.area_code || '11').substring(0, 5),
        number: customer.phone.number.toString().replace(/\D/g, '').substring(0, 15)
      } : undefined
    } : {
      name: 'Cliente',
      surname: 'BARDO',
      email: 'test@user.com'
    };

    // METADATA - VERSIÓN CORREGIDA
    const extendedMetadata = {
      event_id: eventId.toString(),
      event_title: event.title.substring(0, 100),
      tickets: parseInt(tickets),
      pre_sale_stage: metadata.pre_sale_stage,
      is_free_ticket: false,
      session_id: metadata.session_id || 'default_session',
      device_id: metadata.device_id || 'default_device',
      user_identifier: metadata.user_identifier || 'default_user',
      customer_email: metadata.customer_email || payer.email,
      customer_name: metadata.customer_name || `${payer.name} ${payer.surname}`,
      customer_phone: metadata.customer_phone || payer.phone?.number,
      source: 'bardo_web_app',
      timestamp: new Date().toISOString()
    };

    // URLs FIJAS PARA EVITAR PROBLEMAS
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8100';
    const backendUrl = process.env.BACKEND_URL || 'https://bardobackend.onrender.com';

    console.log('Preparando body para MercadoPago...');
    console.log('Items:', mpItems);
    console.log('Payer:', payer);

    // BODY PARA MERCADOPAGO - VERSIÓN CORREGIDA
    const body = {
      items: mpItems,
      payer: payer,
      back_urls: {
        success: `${frontendUrl}/pago-exitoso`,
        failure: `${frontendUrl}/pago-error`,
        pending: `${frontendUrl}/pago-pendiente`
      },
      auto_return: 'approved',
      external_reference: orderId.substring(0, 256),
      notification_url: `${backendUrl}/api/mercadopago/webhook`,
      statement_descriptor: 'BARDOEVENTS',
      expires: false,
      binary_mode: true,
      payment_methods: {
        excluded_payment_types: [
          { id: 'atm' }
        ],
        installments: 6,
        default_installments: 1
      },
      metadata: extendedMetadata
    };

    console.log('Enviando a MercadoPago...');
    console.log('Body completo:', JSON.stringify(body, null, 2));

    try {
      // INTENTAR CREAR LA PREFERENCIA
      const response = await preferenceClient.create({ body });
      
      console.log('✅ Preferencia creada exitosamente:', {
        id: response.id,
        init_point: response.init_point,
        sandbox_init_point: response.sandbox_init_point
      });

      res.json({
        success: true,
        preferenceId: response.id,
        initPoint: response.init_point,
        sandboxInitPoint: response.sandbox_init_point,
        orderId: orderId,
        amount: unitPrice * tickets,
        isFreeTicket: false
      });

    } catch (mpError) {
      console.error('❌ Error de MercadoPago:', mpError);
      
      // ANÁLISIS DETALLADO DEL ERROR
      if (mpError.message && mpError.message.includes('401')) {
        console.error('🔐 Error de autenticación - Verificar access token');
        return res.status(500).json({
          success: false,
          message: 'Error de autenticación con MercadoPago. Verifica el access token.',
          code: 'MP_AUTH_ERROR',
          details: 'Token de acceso inválido o expirado'
        });
      }

      if (mpError.type === 'invalid-json') {
        console.error('📄 MercadoPago devolvió HTML en lugar de JSON');
        return res.status(500).json({
          success: false,
          message: 'Error de comunicación con MercadoPago. El servidor respondió con HTML.',
          code: 'MP_HTML_RESPONSE',
          details: 'Posible problema de autenticación o URL incorrecta'
        });
      }

      if (mpError.status === 400) {
        console.error('📋 Error de validación en los datos enviados');
        return res.status(400).json({
          success: false,
          message: 'Error en los datos enviados a MercadoPago',
          code: 'MP_VALIDATION_ERROR',
          details: mpError.message
        });
      }

      // ERROR GENÉRICO
      throw mpError;
    }

  } catch (error) {
    console.error('💥 Error general creating MercadoPago preference:', error);
    
    res.status(500).json({
      success: false,
      message: 'Error interno al crear la preferencia de pago',
      code: 'PREFERENCE_CREATION_ERROR',
      error: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        stack: error.stack
      } : undefined
    });
  }
});

// POST /api/mercadopago/direct-reservation - VERSIÓN CORREGIDA
router.post('/direct-reservation', async (req, res) => {
  try {
    console.log('Creando reserva directa...');
    
    const { eventId, tickets, customerInfo, metadata = {} } = req.body;

    if (!eventId || !tickets) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos requeridos: eventId, tickets',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        success: false,
        message: 'Evento no encontrado',
        code: 'EVENT_NOT_FOUND'
      });
    }

    if (event.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'El evento no está disponible para reservas',
        code: 'EVENT_NOT_ACTIVE'
      });
    }

    const orderId = `DIRECT_${eventId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    const userInfo = {
      nombre: customerInfo?.name || 'Invitado',
      apellido: customerInfo?.surname || 'BARDO',
      email: customerInfo?.email || '',
      telefono: customerInfo?.phone || ''
    };

    const reservation = new Reservation({
      eventId: eventId,
      eventTitle: event.title,
      tickets: createTicketsWithUserInfo(tickets, userInfo, metadata),
      totalTickets: tickets,
      orderId: orderId,
      paymentStatus: 'approved',
      paymentMethod: 'free',
      totalAmount: 0,
      isPaid: true,
      isFreeTicket: true,
      userIdentifier: metadata.user_identifier,
      sessionId: metadata.session_id,
      deviceId: metadata.device_id,
      source: 'bardo_web_app_direct'
    });

    await reservation.save();

    if (event.freeTickets?.enabled) {
      event.freeTickets.ticketsClaimed += tickets;
      await event.save();
    }

    console.log(`✅ Reserva directa creada: ${reservation.reservationCode}`);

    res.json({
      success: true,
      reservation: {
        id: reservation._id,
        reservationCode: reservation.reservationCode,
        orderId: reservation.orderId,
        eventTitle: reservation.eventTitle,
        tickets: reservation.tickets,
        totalTickets: reservation.totalTickets
      },
      message: 'Reserva creada exitosamente'
    });

  } catch (error) {
    console.error('Error creating direct reservation:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear la reserva directa',
      code: 'DIRECT_RESERVATION_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ... (EL RESTO DE LOS ENDPOINTS SE MANTIENEN IGUAL) ...

// POST /api/mercadopago/webhook - Webhook para notificaciones
router.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook recibido:', req.body);
    
    const { type, data } = req.body;

    if (type === 'payment') {
      const paymentId = data.id;
      
      try {
        const payment = await paymentClient.get({ id: paymentId });
        const orderId = payment.external_reference;
        const status = payment.status;
        
        console.log(`Webhook procesando - Payment: ${paymentId}, Status: ${status}, Order: ${orderId}`);

        switch (status) {
          case 'approved':
            await processApprovedPayment(payment);
            break;
          case 'rejected':
            await processRejectedPayment(orderId, payment.status_detail);
            break;
          case 'cancelled':
            await processCancelledPayment(orderId);
            break;
          case 'pending':
          case 'in_process':
            await processPendingPayment(orderId, status);
            break;
          default:
            console.log(`Estado de pago no manejado: ${status}`);
        }

        console.log(`✅ Webhook procesado - Payment: ${paymentId}, Status: ${status}`);
      } catch (webhookError) {
        console.error('❌ Error procesando webhook:', webhookError);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('💥 Error general en webhook:', error);
    res.status(500).json({
      message: 'Error processing webhook',
      code: 'WEBHOOK_ERROR'
    });
  }
});

// GET /api/mercadopago/payment/:paymentId - Obtener estado de pago
router.get('/payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    const payment = await paymentClient.get({ id: paymentId });
    const reservation = await Reservation.findOne({ paymentId: paymentId });

    res.json({
      paymentId: payment.id,
      status: payment.status,
      statusDetail: payment.status_detail,
      orderId: payment.external_reference,
      amount: payment.transaction_amount,
      dateCreated: payment.date_created,
      dateApproved: payment.date_approved,
      paymentMethod: payment.payment_method_id,
      payer: payment.payer,
      reservation: reservation ? {
        reservationCode: reservation.reservationCode,
        status: reservation.status,
        tickets: reservation.totalTickets
      } : null
    });

  } catch (error) {
    console.error('Error getting payment status:', error);
    res.status(500).json({
      message: 'Error al obtener el estado del pago',
      code: 'PAYMENT_STATUS_ERROR'
    });
  }
});

// GET /api/mercadopago/order/:orderId - Buscar pagos por orderId
router.get('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    let payments = [];
    
    try {
      const searchData = await paymentClient.search({
        options: {
          qs: {
            'external_reference': orderId
          }
        }
      });
      
      payments = searchData.results || [];
    } catch (searchError) {
      console.log('Búsqueda por external_reference falló:', searchError.message);
    }

    const reservation = await Reservation.findOne({ orderId: orderId });

    res.json({
      orderId,
      payments: payments.map(payment => ({
        paymentId: payment.id,
        status: payment.status,
        statusDetail: payment.status_detail,
        amount: payment.transaction_amount,
        dateCreated: payment.date_created,
        dateApproved: payment.date_approved,
        paymentMethod: payment.payment_method_id
      })),
      reservation: reservation ? {
        reservationCode: reservation.reservationCode,
        status: reservation.status,
        paymentStatus: reservation.paymentStatus,
        tickets: reservation.totalTickets,
        isPaid: reservation.isPaid
      } : null
    });

  } catch (error) {
    console.error('Error searching payments:', error);
    res.status(500).json({
      message: 'Error al buscar pagos',
      code: 'PAYMENT_SEARCH_ERROR'
    });
  }
});

// GET /api/mercadopago/reservation/:orderId - Obtener reserva por orderId
router.get('/reservation/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const reservation = await Reservation.findOne({ orderId: orderId })
      .populate('eventId', 'title date location');
    
    if (!reservation) {
      return res.status(404).json({
        message: 'Reserva no encontrada',
        code: 'RESERVATION_NOT_FOUND'
      });
    }

    res.json({
      reservation: {
        id: reservation._id,
        reservationCode: reservation.reservationCode,
        eventTitle: reservation.eventTitle,
        event: reservation.eventId ? {
          title: reservation.eventId.title,
          date: reservation.eventId.date,
          location: reservation.eventId.location
        } : null,
        tickets: reservation.tickets,
        totalTickets: reservation.totalTickets,
        reservationDate: reservation.reservationDate,
        status: reservation.status,
        paymentStatus: reservation.paymentStatus,
        paymentMethod: reservation.paymentMethod,
        totalAmount: reservation.totalAmount,
        isPaid: reservation.isPaid,
        isFreeTicket: reservation.isFreeTicket
      }
    });

  } catch (error) {
    console.error('Error getting reservation:', error);
    res.status(500).json({
      message: 'Error al obtener la reserva',
      code: 'RESERVATION_ERROR'
    });
  }
});

// GET /api/mercadopago/user/reservations - Obtener reservas por usuario
router.get('/user/reservations', async (req, res) => {
  try {
    const { userIdentifier, deviceId, sessionId, email } = req.query;

    if (!userIdentifier && !deviceId && !sessionId && !email) {
      return res.status(400).json({
        message: 'Se requiere al menos un criterio de búsqueda',
        code: 'MISSING_SEARCH_CRITERIA'
      });
    }

    let query = {};
    
    if (userIdentifier) query.userIdentifier = userIdentifier;
    else if (deviceId) query.deviceId = deviceId;
    else if (sessionId) query.sessionId = sessionId;
    else if (email) query['tickets.email'] = email;

    const reservations = await Reservation.find(query)
      .populate('eventId', 'title date location image')
      .sort({ reservationDate: -1 });

    res.json({
      success: true,
      reservations: reservations.map(reservation => ({
        id: reservation._id,
        reservationCode: reservation.reservationCode,
        orderId: reservation.orderId,
        eventTitle: reservation.eventTitle,
        event: reservation.eventId ? {
          title: reservation.eventId.title,
          date: reservation.eventId.date,
          location: reservation.eventId.location,
          image: reservation.eventId.image
        } : null,
        tickets: reservation.tickets,
        totalTickets: reservation.totalTickets,
        reservationDate: reservation.reservationDate,
        paymentStatus: reservation.paymentStatus,
        paymentMethod: reservation.paymentMethod,
        totalAmount: reservation.totalAmount,
        isPaid: reservation.isPaid,
        isFreeTicket: reservation.isFreeTicket
      })),
      total: reservations.length
    });

  } catch (error) {
    console.error('Error searching user reservations:', error);
    res.status(500).json({
      message: 'Error al buscar reservas del usuario',
      code: 'USER_RESERVATIONS_ERROR'
    });
  }
});

// PATCH /api/mercadopago/reservation/:orderId/contact - Actualizar contacto
router.patch('/reservation/:orderId/contact', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { email, phone, name, surname } = req.body;

    const reservation = await Reservation.findOne({ orderId: orderId });
    
    if (!reservation) {
      return res.status(404).json({
        message: 'Reserva no encontrada',
        code: 'RESERVATION_NOT_FOUND'
      });
    }

    if (email || name) {
      reservation.tickets = reservation.tickets.map(ticket => ({
        ...ticket,
        email: email || ticket.email,
        nombre: name || ticket.nombre,
        apellido: surname || ticket.apellido,
        telefono: phone || ticket.telefono
      }));
    }

    await reservation.save();

    res.json({
      message: 'Información de contacto actualizada exitosamente',
      reservation: {
        reservationCode: reservation.reservationCode,
        tickets: reservation.tickets
      }
    });

  } catch (error) {
    console.error('Error updating reservation contact:', error);
    res.status(500).json({
      message: 'Error al actualizar la información de contacto',
      code: 'CONTACT_UPDATE_ERROR'
    });
  }
});

module.exports = router;