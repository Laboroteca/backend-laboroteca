// routes/activarMembresiaClub.js
const express = require('express');
const { activarMembresiaClub } = require('../services/activarMembresiaClub');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

router.post('/', async (req, res) => {
  // 🔐 Solo uso interno
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { email, invoiceId, paymentIntentId } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Falta o email inválido' });
  }
  if (!invoiceId && !paymentIntentId) {
    return res.status(400).json({ error: 'Falta invoiceId o paymentIntentId' });
  }

  try {
    // ✅ Confirmar pago con Stripe
    let paid = false;
    if (invoiceId) {
      const inv = await stripe.invoices.retrieve(invoiceId);
      paid = inv?.paid === true && inv?.status === 'paid';
    } else {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      paid = pi?.status === 'succeeded';
    }
    if (!paid) return res.status(402).json({ error: 'Pago no confirmado' });

    await activarMembresiaClub(email);
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error al activar la membresía:', error?.message || error);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

module.exports = router;
