// services/activarMembresiaClub.js
'use strict';

const admin = require('../firebase');
const firestore = admin.firestore();
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// Utils mínimos (PII-safe)
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const maskEmail = (e = '') => {
  const [u, d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@***${d.slice(-3)}`;
};

/**
 * Activa la membresía del Club para un email.
 * - Normaliza el email (trim + lower-case).
 * - Marca activo=true.
 * - No pisa `fechaAlta` si ya existía.
 * - Guarda metadatos opcionales de activación (activationRef, via, invoiceId, paymentIntentId).
 *
 * @param {string} email
 * @param {Object} [opts]
 * @param {string} [opts.activationRef]   Referencia idempotente de activación (invoiceId o paymentIntentId)
 * @param {string} [opts.via]             Contexto de activación (ej. 'webhook:invoice.paid')
 * @param {string} [opts.invoiceId]       Invoice ID de Stripe (si aplica)
 * @param {string} [opts.paymentIntentId] PaymentIntent ID de Stripe (si aplica)
 * @returns {Promise<boolean>} true si se activó (o ya estaba), false si hubo error
 */
async function activarMembresiaClub(email, opts = {}) {
  try {
    // Validación básica
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      console.warn('[activarMembresiaClub] Email inválido');
      try {
        await alertAdmin({
          area: 'activarMembresiaClub_email_invalido',
          email: lower(email || '-'),              // 👉 admin recibe el email completo (si venía)
          err: { message: 'Email inválido' },
          meta: { email_masked: maskEmail(email || '(no definido)') }
        });
      } catch (_) {}
      return false; // no romper flujo
    }

    // Normaliza el email para evitar duplicados por mayúsculas/espacios
    const emailNorm = lower(email);
    const ref = firestore.collection('usuariosClub').doc(emailNorm);

    // Lee estado actual para no pisar fechaAlta si ya existe
    const snap = await ref.get();
    const nowISO = new Date().toISOString();

    // Base mínima
    const base = {
      email: emailNorm,
      activo: true,
      // Campo auxiliar: cuándo ejecutamos esta activación concreta
      ultimaActivacion: nowISO,
      updatedAt: nowISO
    };

    // Solo si NO existía fechaAlta previamente
    const payload = (snap.exists && snap.data()?.fechaAlta)
      ? base
      : { ...base, fechaAlta: nowISO };

    // Metadatos opcionales (no obligatorios)
    if (opts && typeof opts === 'object') {
      const { activationRef, via, invoiceId, paymentIntentId } = opts;
      if (activationRef)   payload.lastActivationRef = String(activationRef);
      if (via)             payload.lastActivationVia = String(via);
      if (invoiceId)       payload.lastInvoiceId = String(invoiceId);
      if (paymentIntentId) payload.lastPaymentIntentId = String(paymentIntentId);
    }

    await ref.set(payload, { merge: true });

    console.log(`✅ Membresía del Club activada para ${maskEmail(emailNorm)}`);
    return true;
  } catch (err) {
    const emailNorm = lower(email || '(no definido)');
    const emailSafe = maskEmail(emailNorm);
    console.error(`❌ activarMembresiaClub error para ${emailSafe}: ${err?.message || err}`);
    try {
      await alertAdmin({
        area: 'activarMembresiaClub_firestore_error',
        email: emailNorm,                         // 👉 email completo al admin
        err: { message: err?.message, code: err?.code, type: err?.type },
        meta: {
          email_masked: emailSafe,                // opcional: versión enmascarada para auditoría
          // Si venían metadatos, los adjuntamos para depurar
          ...(opts && typeof opts === 'object'
            ? {
                activationRef: opts.activationRef || null,
                via: opts.via || null,
                invoiceId: opts.invoiceId || null,
                paymentIntentId: opts.paymentIntentId || null
              }
            : {})
        }
      });
    } catch (_) {}
    return false; // no romper flujo si Firestore falla
  }
}

module.exports = { activarMembresiaClub };
