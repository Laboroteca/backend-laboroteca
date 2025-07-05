const express = require('express');
const router = express.Router();

const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const TOKEN_ESPERADO = 'baja-club-token-2025';

router.post('/', async (req, res) => {
  const token = req.headers['authorization'] || '';

  if (token !== TOKEN_ESPERADO) {
    console.warn('❌ Token no válido en desactivación de membresía');
    return res.status(401).json({ error: 'Token no autorizado' });
  }

  const { email } = req.body;
  if (!email) {
    console.warn('⚠️ Falta el campo email en el cuerpo de la solicitud');
    return res.status(400).json({ error: 'Falta el email' });
  }

  try {
    await desactivarMembresiaClub(email);

    const customers = await stripe.customers.list({ email: email, limit: 1 });
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

    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: 10663
    });

    return res.json({ ok: true, mensaje: 'Membresía cancelada correctamente.' });
  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error.message || error);
    return res.status(500).json({ error: 'Error al procesar la baja.' });
  }
});

module.exports = router;
