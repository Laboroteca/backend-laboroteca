// routes/webhook.js

const express = require('express');
const router = express.Router();

const Stripe = require('stripe');
const admin = require('../firebase');
const firestore = admin.firestore();
const handleStripeEvent = require('../services/handleStripeEvent');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

console.log('📦 WEBHOOK CARGADO');

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      console.log('🛎️ Stripe webhook recibido:', {
        headers: req.headers,
        body: req.body && req.body.length ? req.body.toString('utf8') : '[empty]'
      });
    } catch (logErr) {}

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      console.log(`🎯 Webhook verificado: ${event.type}`);
    } catch (err) {
      console.error('❌ Firma inválida del webhook:', err.message);
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
      return res.status(500).json({ error: 'Error al manejar evento Stripe' });
    }
  }
);

module.exports = router;
