// 📁 routes/solicitarEliminacionCuenta.js
'use strict';

const express = require('express');
const router = express.Router();

const admin = require('../firebase');
const firestore = admin.firestore();

const crypto = require('crypto');
const { enviarEmailValidacionEliminacionCuenta } = require('../services/email');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// 🔒 HMAC
const { verifyHmac } = require('../utils/verifyHmac');
const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const ELIM_HMAC_SECRET =
  (process.env.LAB_ELIM_HMAC_SECRET || process.env.LAB_BAJA_HMAC_SECRET || '').trim();

// pequeña utilidad para logs sin exponer nada sensible
const _hash10 = (str) => {
  try { return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex').slice(0, 10); }
  catch { return 'errhash'; }
};

router.post('/solicitar-eliminacion', async (req, res) => {
  // ✅ Obligatorio: HMAC desde el proxy WP
  if (!ELIM_HMAC_SECRET) {
    return res.status(500).json({ ok: false, mensaje: 'Config HMAC ausente' });
  }

  const ts  = String(req.headers['x-lab-ts'] || '');
  const sig = String(req.headers['x-lab-sig'] || '');
  const reqId = String(req.headers['x-request-id'] || '');

  if (LAB_DEBUG) {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    console.log('[ELIM HMAC IN]', {
      path: req.path,
      ts,
      bodyHash10: _hash10(raw),
      sig10: sig.slice(0, 10),
      reqId
    });
  }

  const v = verifyHmac({
    method: 'POST',
    path: req.path,
    bodyRaw: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
    headers: req.headers,
    secret: ELIM_HMAC_SECRET
  });

  if (!v.ok) {
    if (LAB_DEBUG) console.warn('[ELIM HMAC FAIL]', v.error, { reqId, ts, sig10: sig.slice(0,10) });
    return res.status(401).json({ ok: false, mensaje: 'Auth HMAC inválida', error: v.error });
  }

  // ⤵️ Cuerpo validado por WP: solo necesitamos el email
  const email = String((req.body?.email || '')).trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, mensaje: 'Email inválido.' });
  }

  if (LAB_DEBUG) console.log('[ELIM HMAC USED]', { reqId, email });

  try {
    // 1) Generar token y caducidad (2h)
    const token  = crypto.randomBytes(32).toString('hex');
    const ahora  = Date.now();
    const expira = ahora + 1000 * 60 * 60 * 2;

    // 2) Limpiar tokens previos de ese email (opcional recomendado)
    try {
      const prev = await firestore.collection('eliminacionCuentas')
        .where('email', '==', email).get();
      if (!prev.empty) {
        const batch = firestore.batch();
        prev.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.warn('⚠️ No se pudieron limpiar tokens previos:', e?.message || e);
    }

    // 3) Guardar token
    await firestore.collection('eliminacionCuentas').doc(token).set({
      email,
      expira,
      createdAt: ahora
    });

    // 4) Enviar email con enlace de validación
    try {
      await enviarEmailValidacionEliminacionCuenta(email, token);
    } catch (e) {
      console.error('❌ Error enviando email de validación:', e?.message || e);
      try {
        await alertAdmin({
          area: 'elim_cuenta_email_validacion',
          email,
          err: e,
          meta: {}
        });
      } catch (_) {}
      return res.status(500).json({ ok: false, mensaje: 'No se pudo enviar el email de validación.' });
    }

    if (LAB_DEBUG) console.log('[ELIM HMAC OK]', { reqId, email });

    // 5) OK
    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ Error al solicitar eliminación de cuenta:', err?.message || err);
    try {
      await alertAdmin({
        area: 'solicitar_eliminacion_error',
        email,
        err,
        meta: {}
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
