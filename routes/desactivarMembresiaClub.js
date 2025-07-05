const express = require('express');
const router = express.Router();

const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const TOKEN_ESPERADO = 'baja-club-token-2025';

router.post('/', async (req, res) => {
  const token = req.headers['authorization'];

  if (token !== TOKEN_ESPERADO) {
    return res.status(403).json({ error: 'Token inválido' });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Falta el email' });
  }

  try {
    // 🔄 Desactivar en Firestore
    await desactivarMembresiaClub(email);

    // 🔄 Cancelar suscripción en Stripe
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length) {
      const customerId = customers.data[0].id;
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });

      if (subs.data.length) {
        const subscriptionId = subs.data[0].id;
        await stripe.subscriptions.del(subscriptionId);
        console.log(`🛑 Suscripción ${subscriptionId} cancelada en Stripe para ${email}`);
      } else {
        console.warn(`ℹ️ No hay suscripción activa en Stripe para ${email}`);
      }
    } else {
      console.warn(`⚠️ No se encontró cliente Stripe con email ${email}`);
    }

    // 🔄 Desactivar en MemberPress
    await syncMemberpressClub({ email, accion: 'desactivar', membership_id: 10663 });

    return res.json({ ok: true, mensaje: 'Membresía cancelada correctamente.' });
  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error.message);
    return res.status(500).json({ error: 'Error al procesar la baja.' });
  }
});

module.exports = router;
