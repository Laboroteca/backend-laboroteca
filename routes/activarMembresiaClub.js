// routes/activarMembresiaClub.js
'use strict';

const express = require('express');
const Stripe = require('stripe');
const { activarMembresiaClub } = require('../services/activarMembresiaClub');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// Flags y utilidades mínimas (seguras por defecto)
const ENFORCE_STRIPE_EMAIL_MATCH = String(process.env.ENFORCE_STRIPE_EMAIL_MATCH || '') === '1';
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const maskEmail = (e = '') => {
  const [u, d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@***${d.slice(-3)}`;
};
const getReqId = (req) => req.headers['x-request-id'] || `r_${Date.now()}`;

router.post('/', async (req, res) => {
  const request_id = getReqId(req);

  try {
    // 🔐 Solo uso interno (API key simple; HMAC opcional en otra iteración)
    const internalKey = String(req.headers['x-internal-key'] || '');
    if (!internalKey || internalKey !== process.env.INTERNAL_API_KEY) {
      try {
        await alertAdmin({
          area: 'club.activate.forbidden',
          err: new Error('bad_internal_key'),
          meta: { ip: req.ip, request_id }
        });
      } catch (_) {}
      return res.status(403).json({ error: 'Forbidden', request_id });
    }

    // 📨 Normalización de entrada
    const email = lower((req.body?.email || '').toString());
    const invoiceId = (req.body?.invoiceId || '').toString().trim();
    const paymentIntentId = (req.body?.paymentIntentId || '').toString().trim();

    // ✔️ Validaciones básicas
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Falta o email inválido', request_id });
    }
    if (!invoiceId && !paymentIntentId) {
      return res.status(400).json({ error: 'Falta invoiceId o paymentIntentId', request_id });
    }

    // ✅ Confirmar pago con Stripe
    let paid = false;
    let source = '';
    let stripeEmail = '';

    if (invoiceId) {
      const inv = await stripe.invoices
        .retrieve(invoiceId, { expand: ['customer'] })
        .catch((e) => {
          throw new Error(`invoice_retrieve: ${e.message}`);
        });

      paid = inv?.paid === true && inv?.status === 'paid';
      source = 'invoice';
      stripeEmail = lower(inv?.customer_email || inv?.customer?.email || '');
    } else {
      const pi = await stripe.paymentIntents
        .retrieve(paymentIntentId, { expand: ['charges.data.billing_details', 'customer'] })
        .catch((e) => {
          throw new Error(`pi_retrieve: ${e.message}`);
        });

      paid = pi?.status === 'succeeded';
      source = 'payment_intent';
      const ch0 = pi?.charges?.data?.[0];
      stripeEmail = lower(pi?.receipt_email || pi?.customer?.email || ch0?.billing_details?.email || '');
    }

    // 🛡️ (Opcional por entorno) exigir coincidencia de email con Stripe si lo aporta
    if (ENFORCE_STRIPE_EMAIL_MATCH && stripeEmail && stripeEmail !== email) {
      try {
        await alertAdmin({
          area: 'club.activate.email_mismatch',
          email, // ← email completo en el aviso al admin
          err: new Error('stripe_email_mismatch'),
          meta: {
            stripeEmail: maskEmail(stripeEmail),
            invoiceId: invoiceId ? `${invoiceId.slice(0, 4)}***` : null,
            paymentIntentId: paymentIntentId ? `${paymentIntentId.slice(0, 6)}***` : null,
            request_id
          }
        });
      } catch (_) {}
      return res.status(409).json({ error: 'Email no coincide con el pago', request_id });
    }

    if (!paid) {
      return res.status(402).json({ error: 'Pago no confirmado', request_id });
    }

    // 🔁 Idempotencia aguas abajo (referencia única de activación)
    const activationRef = invoiceId || paymentIntentId;

    await activarMembresiaClub(email, {
      activationRef,
      invoiceId: invoiceId || null,
      paymentIntentId: paymentIntentId || null,
      via: 'route:activarMembresiaClub'
    });

    return res.json({ ok: true, via: source, request_id });
  } catch (error) {
    console.error(`[club.activate] ${request_id} ERROR: ${error?.message || error}`);
    try {
      await alertAdmin({
        area: 'club.activate.error',
        err: { message: error?.message, code: error?.code, type: error?.type },
        meta: {
          email: lower((req.body?.email || '').toString()), // ← email completo en el aviso al admin
          invoiceId: req.body?.invoiceId ? `${String(req.body.invoiceId).slice(0, 4)}***` : null,
          paymentIntentId: req.body?.paymentIntentId ? `${String(req.body.paymentIntentId).slice(0, 6)}***` : null,
          request_id
        }
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Error al activar la membresía', request_id });
  }
});

module.exports = router;
