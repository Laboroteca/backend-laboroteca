// routes/webhook.js

const express = require('express');
const router = express.Router();

const Stripe = require('stripe');
const admin = require('../firebase');
const firestore = admin.firestore();
const handleStripeEvent = require('../services/handleStripeEvent');
const { alertAdmin } = require('../utils/alertAdmin');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

console.log('📦 WEBHOOK CARGADO');

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // No toques req.body antes de verificar firma
      console.log('🛎️ Stripe webhook recibido:');
      console.log('headers:', req.headers);
    } catch (logErr) {}

    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      console.log(`🎯 Webhook verificado: ${event.type}`);
    } catch (err) {
      console.error('❌ Firma inválida del webhook:', err.message);
try {
  await alertAdmin({
    area: 'stripe_webhook_signature',
    email: '-', // no hay email aquí
    err,
    meta: {
      hint: 'Firma inválida al verificar Stripe webhook',
      eventType: 'desconocido',
      headersSubset: {
        'stripe-signature': req.headers['stripe-signature'] || null,
        'user-agent': req.headers['user-agent'] || null,
        'content-type': req.headers['content-type'] || null
      },
      bodyLength: Buffer.isBuffer(req.body) ? req.body.length : null,
      ip: req.ip || req.connection?.remoteAddress || null
    }
  });
} catch (_) { /* nunca romper por fallo en alertAdmin */ }
return res.status(400).send(`Webhook Error: ${err.message}`);

    }

    try {
      const eventId = event.id;
      const processedRef = firestore.collection('stripeWebhookProcesados').doc(eventId);

      const alreadyProcessed = await firestore.runTransaction(async (transaction) => {
        const doc = await transaction.get(processedRef);
        if (doc.exists) return true;
        transaction.set(processedRef, {
          type: event.type,
          fecha: new Date().toISOString()
        });
        return false;
      });

      if (alreadyProcessed) {
        console.warn(`⛔️ [WEBHOOK] Evento duplicado ignorado: ${eventId}`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      // 🧠 Delegar gestión al handler central
      const result = await handleStripeEvent(event);
      return res.status(200).json({ received: true, ...result });

    } catch (err) {
console.error('❌ Error al manejar evento Stripe:', err.stack || err);
try {
  await alertAdmin({
    area: 'stripe_webhook_handle',
    email: '-', // no conocemos email aquí
    err,
    meta: {
      eventId: event?.id || null,
      eventType: event?.type || null,
      created: event?.created || null
    }
  });
} catch (_) { /* no-op */ }
return res.status(500).json({ error: 'Error al manejar evento Stripe' });

    }
  }
);

module.exports = router;
