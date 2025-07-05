// routes/cancelarSuscripcionClub.js

const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { wpAuthenticateUser } = require('../services/wordpress');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

router.post('/cancelar-suscripcion-club', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ cancelada: false, mensaje: 'Faltan datos obligatorios.' });
  }

  try {
    // Verifica login contra WordPress
    const user = await wpAuthenticateUser(email, password);
    if (!user) {
      return res.status(401).json({ cancelada: false, mensaje: 'Login incorrecto.' });
    }

    // Cancela suscripción activa en Stripe
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length > 0) {
      const customerId = customers.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1
      });

      if (subs.data.length > 0) {
        const subscriptionId = subs.data[0].id;
        await stripe.subscriptions.cancel(subscriptionId);
        console.log(`🛑 Suscripción ${subscriptionId} cancelada en Stripe para ${email}`);
      } else {
        console.log(`ℹ️ Cliente ${email} no tiene suscripciones activas`);
      }
    } else {
      console.log(`⚠️ No se encontró cliente en Stripe con email ${email}`);
    }

    // Desactiva membresía en MemberPress
    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: 10663
    });

    return res.json({ cancelada: true, mensaje: 'Suscripción cancelada correctamente.' });

  } catch (error) {
    console.error('❌ Error al cancelar suscripción:', error.message || error);
    return res.status(500).json({ cancelada: false, mensaje: 'Error interno al cancelar la suscripción.' });
  }
});

module.exports = router;
