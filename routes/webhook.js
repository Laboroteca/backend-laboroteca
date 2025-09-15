// routes/webhook.js

const express = require('express');
const router = express.Router();

const Stripe = require('stripe');
const admin = require('../firebase');
const firestore = admin.firestore();
const handleStripeEvent = require('../services/handleStripeEvent');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

console.log('📦 WEBHOOK CARGADO');

// ── LRU simple en memoria para dedupe cuando Firestore falle (no bloqueante)
const RECENT_MAX = Number(process.env.WEBHOOK_RECENT_MAX || 3000); // tamaño máx del LRU
const RECENT_TTL_MS = Number(process.env.WEBHOOK_RECENT_TTL_MS || 6 * 60 * 60 * 1000); // 6h
const _recent = new Map(); // eventId -> expiresAt
function recentSeen(id) {
  const now = Date.now();
  const exp = _recent.get(id);
  if (exp && exp > now) return true;
  _recent.delete(id);
  return false;
}
function recentRemember(id) {
  const now = Date.now();
  _recent.set(id, now + RECENT_TTL_MS);
  if (_recent.size > RECENT_MAX) {
    // borrar el más antiguo (iteración en inserción, suficiente aquí)
    const firstKey = _recent.keys().next().value;
    if (firstKey) _recent.delete(firstKey);
  }
}
function recentGc() {
  const now = Date.now();
  for (const [k, exp] of _recent) if (exp <= now) _recent.delete(k);
}
setInterval(recentGc, 10 * 60 * 1000).unref();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // No toques req.body antes de verificar firma
      console.log('🛎️ Stripe webhook recibido');
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

      let alreadyProcessed = false;
      try {
        alreadyProcessed = await firestore.runTransaction(async (transaction) => {
          const doc = await transaction.get(processedRef);
          if (doc.exists) return true;
          transaction.set(processedRef, {
            type: event.type,
            fecha: new Date().toISOString()
          });
          return false;
        });
      } catch (fsErr) {
        // ❗ Firestore KO (cuota / outage). NO bloqueamos el flujo.
        console.warn('⚠️ Firestore dedupe falló, usando LRU en memoria:', fsErr?.message || fsErr);
        try {
          await alertAdmin({
            area: 'webhook_dedupe_firestore_fail',
            email: '-',
            err: fsErr,
            meta: { eventId, eventType: event?.type || null }
          });
        } catch (_) {}
        // Dedupe en memoria para evitar reprocesados durante la caída
        if (recentSeen(eventId)) {
          console.warn(`⛔️ [WEBHOOK] Evento duplicado (LRU) ignorado: ${eventId}`);
          return res.status(200).json({ received: true, duplicate: true, dedupe: 'memory' });
        }
        recentRemember(eventId);
      }

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
