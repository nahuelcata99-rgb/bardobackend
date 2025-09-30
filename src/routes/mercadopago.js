const express = require('express');
const router = express.Router();
const { MercadoPagoConfig, Preference, Payment, MerchantOrder } = require('mercadopago');
const Reservation = require('../models/Reservation');
const Event = require('../models/Event');

// Configurar MercadoPago para v2.9.0
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || 'TEST-ACCESS-TOKEN',
  options: { timeout: 5000, idempotencyKey: 'bardo-app' }
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

// POST /api/mercadopago/create-preference - Crear preferencia de pago (ACTUALIZADO)
router.post('/create-preference', async (req, res) => {
  try {
    const { items, orderId, eventId, tickets, customer, metadata = {} } = req.body;

    if (!items || !orderId || !eventId || !tickets) {
      return res.status(400).json({
        message: 'Faltan campos requeridos: items, orderId, eventId, tickets',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        message: 'Evento no encontrado',
        code: 'EVENT_NOT_FOUND'
      });
    }

    if (event.status !== 'active') {
      return res.status(400).json({
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
            message: `No hay suficientes entradas disponibles en la etapa ${stageName}`,
            code: 'STAGE_SOLD_OUT',
            available: stage.ticketLimit - stage.ticketsSold
          });
        }
      } else {
        return res.status(400).json({
          message: 'La etapa de preventa seleccionada no está disponible',
          code: 'STAGE_NOT_AVAILABLE'
        });
      }
    }

    const isFreeTicket = metadata.is_free_ticket === true;
    if (isFreeTicket) {
      if (!event.freeTickets?.enabled) {
        return res.status(400).json({
          message: 'Este evento no tiene entradas gratis disponibles',
          code: 'FREE_TICKETS_DISABLED'
        });
      }

      if (event.freeTickets.quantity > 0 && 
          event.freeTickets.ticketsClaimed + tickets > event.freeTickets.quantity) {
        return res.status(400).json({
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
          message: 'Error al procesar la entrada gratis',
          code: 'FREE_TICKET_ERROR'
        });
      }
    }

    const mpItems = items.map(item => ({
      title: item.title?.substring(0, 256) || `Entrada para ${event.title}`.substring(0, 256),
      unit_price: unitPrice,
      quantity: Number(item.quantity) || Number(tickets),
      currency_id: item.currency_id || 'ARS',
      description: item.description ? item.description.substring(0, 256) : `Evento: ${event.title} - ${stageName}`,
      picture_url: item.picture_url || event.image
    }));

    const payer = customer ? {
      name: customer.name || 'Cliente',
      surname: customer.surname || 'BARDO',
      email: customer.email,
      phone: customer.phone ? {
        area_code: customer.phone.area_code || '11',
        number: customer.phone.number.toString().replace(/\D/g, '')
      } : undefined
    } : {};

    const extendedMetadata = {
      event_id: eventId,
      event_title: event.title,
      tickets: tickets,
      pre_sale_stage: metadata.pre_sale_stage,
      is_free_ticket: false,
      session_id: metadata.session_id,
      device_id: metadata.device_id,
      user_identifier: metadata.user_identifier,
      customer_email: metadata.customer_email,
      customer_name: metadata.customer_name,
      customer_phone: metadata.customer_phone,
      source: 'bardo_web_app',
      timestamp: new Date().toISOString()
    };

    // CORRECCIÓN: Usar URLs fijas si las variables de entorno no están definidas
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    const backendUrl = process.env.BACKEND_URL || 'https://bardobackend.onrender.com';

    // SINTÁXIS ACTUALIZADA para v2.9.0
    const body = {
      items: mpItems,
      payer: payer,
      back_urls: {
        success: `${frontendUrl}/pago-exitoso`,
        failure: `${frontendUrl}/pago-error`, 
        pending: `${frontendUrl}/pago-pendiente`
      },
      auto_return: 'approved',
      external_reference: orderId,
      notification_url: `${backendUrl}/api/mercadopago/webhook`,
      statement_descriptor: 'BARDO EVENTOS',
      expires: false,
      binary_mode: true,
      payment_methods: {
        excluded_payment_types: [{ id: 'atm' }],
        installments: 12,
        default_installments: 1
      },
      metadata: extendedMetadata
    };

    // LLAMADA ACTUALIZADA
    const response = await preferenceClient.create({ body });
    
    res.json({
      success: true,
      preferenceId: response.id,
      initPoint: response.init_point,
      sandboxInitPoint: response.sandbox_init_point,
      orderId: orderId,
      amount: unitPrice * tickets,
      isFreeTicket: false
    });

  } catch (error) {
    console.error('Error creating MercadoPago preference:', error);
    res.status(500).json({
      message: 'Error al crear la preferencia de pago',
      code: 'PREFERENCE_CREATION_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/mercadopago/direct-reservation - Crear reserva directa (SE MANTIENE IGUAL)
router.post('/direct-reservation', async (req, res) => {
  try {
    const { eventId, tickets, customerInfo, metadata = {} } = req.body;

    if (!eventId || !tickets) {
      return res.status(400).json({
        message: 'Faltan campos requeridos: eventId, tickets',
        code: 'MISSING_REQUIRED_FIELDS'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        message: 'Evento no encontrado',
        code: 'EVENT_NOT_FOUND'
      });
    }

    if (event.status !== 'active') {
      return res.status(400).json({
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
      message: 'Error al crear la reserva directa',
      code: 'DIRECT_RESERVATION_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/mercadopago/webhook - Webhook para notificaciones (ACTUALIZADO)
router.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment') {
      const paymentId = data.id;
      
      // SINTÁXIS ACTUALIZADA
      const payment = await paymentClient.get({ id: paymentId });
      
      const orderId = payment.external_reference;
      const status = payment.status;
      
      console.log(`Webhook recibido - Payment: ${paymentId}, Status: ${status}, Order: ${orderId}`);

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

      console.log(`Webhook procesado - Payment: ${paymentId}, Status: ${status}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({
      message: 'Error processing webhook',
      code: 'WEBHOOK_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/mercadopago/payment/:paymentId - Obtener estado de pago (ACTUALIZADO)
router.get('/payment/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    // SINTÁXIS ACTUALIZADA
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

// GET /api/mercadopago/order/:orderId - Buscar pagos por orderId (ACTUALIZADO)
router.get('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    // SINTÁXIS ACTUALIZADA - Usar MerchantOrder para búsquedas
    let payments = [];
    
    try {
      // Intentar buscar por external_reference usando filters
      const searchData = await paymentClient.search({
        options: {
          qs: {
            'external_reference': orderId
          }
        }
      });
      
      payments = searchData.results || [];
    } catch (searchError) {
      console.log('Search by external_reference failed, trying alternative approach');
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

// GET /api/mercadopago/reservation/:orderId - Obtener reserva por orderId (SE MANTIENE)
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

// GET /api/mercadopago/user/reservations - Obtener reservas por usuario (SE MANTIENE)
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

// PATCH /api/mercadopago/reservation/:orderId/contact - Actualizar contacto (SE MANTIENE)
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