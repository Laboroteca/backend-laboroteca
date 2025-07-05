// routes/cancelarSuscripcionClub.js

const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const CLUB_MEMBERSHIP_ID = 10663;

// POST /cancelar-suscripcion-club
router.post('/', async (req, res) => {
  const { email, password, token } = req.body;

  if (!email || !password) {
    return res.status(400).json({ cancelada: false, mensaje: 'Faltan datos obligatorios.' });
  }

  // Validación opcional con token de seguridad
  if (process.env.TOKEN_DESACTIVACION && token !== process.env.TOKEN_DESACTIVACION) {
    return res.status(403).json({ cancelada: false, mensaje: 'Token inválido.' });
  }

  try {
    // 🔄 Cancelar suscripción en Stripe
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length > 0) {
      const customerId = customers.data[0].id;

      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 10
      });

      if (subs.data.length > 0) {
        for (const sub of subs.data) {
          await stripe.subscriptions.cancel(sub.id);
          console.log(`🛑 Suscripción ${sub.id} cancelada en Stripe para ${email}`);
        }
      } else {
        console.log(`ℹ️ No hay suscripciones activas para ${email}`);
      }
    } else {
      console.log(`⚠️ Cliente no encontrado en Stripe para ${email}`);
    }

    // ❌ Desactivar en MemberPress
    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: CLUB_MEMBERSHIP_ID
    });

    return res.json({ cancelada: true, mensaje: 'Suscripción cancelada correctamente.' });

  } catch (error) {
    console.error('❌ Error cancelando suscripción:', error.message || error);
    return res.status(500).json({ cancelada: false, mensaje: 'Error interno al cancelar la suscripción.' });
  }
});

module.exports = router;
