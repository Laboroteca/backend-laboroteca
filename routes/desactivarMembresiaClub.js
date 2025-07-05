const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const CLUB_MEMBERSHIP_ID = 10663;

// POST /cancelar-suscripcion-club
router.post('/', async (req, res) => {
  const { email, password, token } = req.body;

  // Validación básica
  if (!email || !password) {
    return res.status(400).json({
      cancelada: false,
      mensaje: 'Faltan datos obligatorios.'
    });
  }

  // Validación del token de seguridad
  if (process.env.TOKEN_DESACTIVACION && token !== process.env.TOKEN_DESACTIVACION) {
    return res.status(403).json({
      cancelada: false,
      mensaje: 'Token inválido.'
    });
  }

  try {
    // Buscar cliente en Stripe
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (!clientes.data.length) {
      console.warn(`⚠️ Cliente no encontrado en Stripe para ${email}`);
    } else {
      const customerId = clientes.data[0].id;

      // Cancelar todas las suscripciones activas
      const subsActivas = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 10
      });

      if (subsActivas.data.length) {
        for (const sub of subsActivas.data) {
          await stripe.subscriptions.cancel(sub.id);
          console.log(`🛑 Suscripción ${sub.id} cancelada en Stripe para ${email}`);
        }
      } else {
        console.log(`ℹ️ No hay suscripciones activas en Stripe para ${email}`);
      }
    }

    // Desactivar acceso en MemberPress
    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: CLUB_MEMBERSHIP_ID
    });

    return res.json({
      cancelada: true,
      mensaje: 'Suscripción cancelada correctamente.'
    });

  } catch (error) {
    console.error('❌ Error al cancelar la suscripción:', error.message || error);
    return res.status(500).json({
      cancelada: false,
      mensaje: 'Error interno al cancelar la suscripción.'
    });
  }
});

module.exports = router;
