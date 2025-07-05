const express = require('express');
const router = express.Router();

const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Token secreto para autorizar la petición desde Fluent Forms
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
    // 🔄 Paso 1: Desactivar en Firestore
    await desactivarMembresiaClub(email);

    // 🔄 Paso 2: Cancelar suscripción activa en Stripe (si existe)
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (customers.data.length) {
      const customerId = customers.data[0].id;
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });

      if (subs.data.length) {
        const subscriptionId = subs.data[0].id;
        await stripe.subscriptions.del(subscriptionId);
        console.log(`🛑 Suscripción ${subscriptionId} cancelada en Stripe para ${email}`);
      } else {
        console.log(`ℹ️ Cliente ${email} no tiene suscripción activa en Stripe`);
      }
    } else {
      console.log(`⚠️ No se encontró cliente en Stripe con email ${email}`);
    }

    // 🔄 Paso 3: Desactivar en MemberPress
    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: 10663
    });

    return res.json({ ok: true, mensaje: 'Membresía cancelada correctamente.' });

  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error.message);
    return res.status(500).json({ error: 'Error al procesar la baja.' });
  }
});

module.exports = router;
