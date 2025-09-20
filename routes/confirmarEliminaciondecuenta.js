// 📁 routes/confirmarEliminaciondecuenta.js
'use strict';

const express = require('express');
const router = express.Router();

const admin = require('../firebase');
const firestore = admin.firestore();

const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const { borrarDatosUsuarioFirestore } = require('../services/borrarDatosUsuarioFirestore');
const { enviarEmailPersonalizado } = require('../services/email');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

// 🔧 Stripe (cancelación inmediata)
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 🔒 HMAC (opcional en este paso: si llega, se valida y se loguea)
const { verifyHmac } = require('../utils/verifyHmac');
const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const REQUIRE_HMAC = (process.env.LAB_REQUIRE_HMAC === '1'); // usa el mismo flag global
const ELIM_HMAC_SECRET =
  (process.env.LAB_ELIM_HMAC_SECRET || process.env.LAB_BAJA_HMAC_SECRET || '').trim();

const crypto = require('crypto');
const _hash10 = (s) => {
  try { return crypto.createHash('sha256').update(String(s),'utf8').digest('hex').slice(0,10); }
  catch { return 'errhash'; }
};

// ———————————————————————————————————————————————————————
// Helper: cancelar suscripciones Stripe por email (INMEDIATA)
// ———————————————————————————————————————————————————————
async function cancelarSuscripcionesStripePorEmail(email) {
  try {
    const customers = await stripe.customers.list({ email, limit: 10 });
    if (!customers.data.length) return { ok: true, canceladas: 0, detalle: 'no_customers' };

    let canceladas = 0;
    const errores = [];

    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 });
      for (const s of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)) {
          // anotar motivo para trazas
          try {
            await stripe.subscriptions.update(s.id, {
              metadata: { ...(s.metadata || {}), motivo_baja: 'eliminacion_cuenta', origen_baja: 'eliminacion_cuenta' }
            });
          } catch (_) {}

          try {
            await stripe.subscriptions.cancel(s.id, {
              cancellation_details: { comment: 'Eliminación de cuenta' }
            });
            canceladas++;
          } catch (e) {
            errores.push({ subscriptionId: s.id, error: e?.message || String(e) });
          }
        }
      }
    }

    if (errores.length) return { ok: false, canceladas, errores };
    return { ok: true, canceladas };
  } catch (e) {
    return { ok: false, canceladas: 0, errores: [{ error: e?.message || String(e) }] };
  }
}

// ———————————————————————————————————————————————————————
// Fallback de fuerza bruta (Stripe+MemberPress+Firestore)
// ———————————————————————————————————————————————————————
async function forzarDesactivacionTotal(email) {
  const resumen = { stripe: false, memberpress: false, firestore: false, errores: [] };

  // Stripe (reintento)
  try {
    const customers = await stripe.customers.list({ email, limit: 10 });
    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 });
      for (const s of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)) {
          try { await stripe.subscriptions.update(s.id, { metadata: { ...(s.metadata||{}), motivo_baja: 'eliminacion_cuenta', origen_baja: 'eliminacion_cuenta' } }); } catch (_) {}
          try { await stripe.subscriptions.cancel(s.id, { cancellation_details: { comment: 'Eliminación de cuenta (fallback)' } }); }
          catch (e) { resumen.errores.push(`Stripe cancel ${s.id}: ${e?.message || e}`); }
        }
      }
    }
    // comprobar si quedan activas
    let quedanActivas = false;
    for (const c of (await stripe.customers.list({ email, limit: 10 })).data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
      if (subs.data.length) { quedanActivas = true; break; }
    }
    resumen.stripe = !quedanActivas;
  } catch (e) {
    resumen.errores.push(`Stripe listado: ${e?.message || e}`);
  }

  // MemberPress
  try {
    await syncMemberpressClub({ email, accion: 'desactivar', membership_id: 10663 });
    resumen.memberpress = true;
  } catch (e) {
    resumen.errores.push(`MemberPress: ${e?.message || e}`);
  }

  // Firestore flag
  try {
    await firestore.collection('usuariosClub').doc(email).set({
      activo: false,
      fechaBaja: new Date().toISOString(),
      motivoBaja: 'eliminacion_cuenta'
    }, { merge: true });
    resumen.firestore = true;
  } catch (e) {
    resumen.errores.push(`Firestore: ${e?.message || e}`);
  }

  return { ok: (resumen.stripe && resumen.memberpress && resumen.firestore), resumen };
}

// ———————————————————————————————————————————————————————
// Endpoint
// ———————————————————————————————————————————————————————
router.post('/confirmar-eliminacion', async (req, res) => {
  // HMAC opcional (si llega, se valida para trazabilidad extra)
  const ts  = String(req.headers['x-lab-ts'] || '');
  const sig = String(req.headers['x-lab-sig'] || '');
  const reqId = String(req.headers['x-request-id'] || '');
  const hasHmac = !!(ts || sig || reqId);
  if (REQUIRE_HMAC && !hasHmac) {
    return res.status(401).json({ ok:false, mensaje: 'HMAC requerido (LAB_REQUIRE_HMAC=1)' });
  }

  if (hasHmac && ELIM_HMAC_SECRET) {
    if (LAB_DEBUG) {
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      console.log('[ELIM CONF HMAC IN]', { path: req.path, ts, bodyHash10: _hash10(raw), sig10: sig.slice(0,10), reqId });
    }
    const v = verifyHmac({
      method: 'POST',
      path: req.path,
      bodyRaw: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
      headers: req.headers,
      secret: ELIM_HMAC_SECRET
    });
    if (!v.ok) {
      if (LAB_DEBUG) console.warn('[ELIM CONF HMAC FAIL]', v.error, { reqId, ts, sig10: sig.slice(0,10) });
      return res.status(401).json({ ok:false, mensaje:'Auth HMAC inválida', error:v.error });
    }
    if (LAB_DEBUG) console.log('[ELIM CONF HMAC OK]', { reqId });
  }

  const token = String(req.body?.token || '').trim();
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ ok: false, mensaje: 'Falta o es inválido el token de verificación.' });
  }

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'El enlace no es válido o ya ha sido utilizado.' });

    const { email, expira } = snap.data() || {};
    const ahora = Date.now();

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      await ref.delete().catch(() => {});
      return res.status(400).json({ ok: false, mensaje: 'Email no válido.' });
    }
    if (!expira || ahora > expira) {
      await ref.delete().catch(() => {});
      return res.status(410).json({ ok: false, mensaje: 'El enlace ha caducado.' });
    }

    if (LAB_DEBUG) console.log('[ELIM CONF START]', { email });

    // 1) Cancelación inmediata en Stripe (SIEMPRE)
    const rStripe = await cancelarSuscripcionesStripePorEmail(email);

    // 2) Desactivar MemberPress (directo)
    let mpOk = false;
    try {
      await syncMemberpressClub({ email, accion: 'desactivar', membership_id: 10663 });
      mpOk = true;
    } catch (_) {}

    // 3) Flag en Firestore (usuariosClub)
    let fsOk = false;
    try {
      await firestore.collection('usuariosClub').doc(email).set({
        activo: false,
        fechaBaja: new Date().toISOString(),
        motivoBaja: 'eliminacion_cuenta'
      }, { merge: true });
      fsOk = true;
    } catch (_) {}

    // 4) Borrado de data adicional en Firestore
    try { await borrarDatosUsuarioFirestore(email); } catch (_) {}

    // 5) Eliminar usuario en WordPress
    const rWP = await eliminarUsuarioWordPress(email);

    // 6) Resultado agregado
    let verificacion = (rStripe.ok && mpOk && fsOk && rWP.ok) ? 'CORRECTO' : 'FALLIDA';

    // 7) Fallback si FALLIDA
    let rForzado = null;
    if (verificacion === 'FALLIDA') {
      rForzado = await forzarDesactivacionTotal(email);
      if (rForzado.ok) verificacion = 'CORRECTO';
    }

    // 8) Token fuera y email al usuario — SIEMPRE neutro
    await ref.delete().catch(() => {});
    await enviarEmailPersonalizado({
      to: email,
      subject: 'Cuenta eliminada con éxito',
      html: `
        <p><strong>✅ Tu cuenta en Laboroteca ha sido eliminada correctamente.</strong></p>
        <p>Gracias por habernos acompañado. Si alguna vez decides volver, estaremos encantados de recibirte.</p>
      `,
      text: 'Tu cuenta en Laboroteca ha sido eliminada correctamente. Gracias por tu confianza.',
      enviarACopy: true
    });

    if (verificacion === 'FALLIDA') {
      try {
        await alertAdmin({
          area: 'eliminacion_cuenta_desactivacion_fallida',
          email,
          err: new Error('Una o más acciones no se completaron'),
          meta: { stripe: rStripe, memberpress: mpOk, firestore: fsOk, wp: rWP, fallback: rForzado }
        });
      } catch (_) {}
    }

    if (LAB_DEBUG) console.log('[ELIM CONF END]', { email, verificacion });

    return res.json({ ok: true, verificacion });

  } catch (err) {
    console.error('❌ Error al confirmar eliminación:', err?.message || err);
    try {
      await alertAdmin({ area: 'confirmar_eliminacion_error', email: (req.body?.email || '-'), err, meta: {} });
    } catch (_) {}
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
