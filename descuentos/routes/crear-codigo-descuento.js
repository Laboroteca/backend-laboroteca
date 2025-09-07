// 📂 descuentos/routes/crear-codigo-descuento.js
'use strict';

const express = require('express');
const router = express.Router();

const { crearCodigoDescuento } = require('../services/crear-descuento'); // <-- ojo al path del service
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const REQUIRE_HMAC = process.env.LAB_REQUIRE_HMAC === '1';
const HSEC = String(
  process.env.DESCUENTOS_HMAC_SECRET ||
  process.env.ENTRADAS_HMAC_SECRET || // fallback por compat
  ''
).trim();

const API_KEY = String(
  process.env.DESCUENTOS_API_KEY ||
  process.env.ENTRADAS_API_KEY || '' // fallback por compat
).trim();

function getSigHeaders(req) {
  // Acepta x-lab-*, x-entr-* y x-e-*
  const ts = String(
    req.headers['x-lab-ts'] ||
    req.headers['x_lb_ts'] ||
    req.headers['x-entr-ts'] ||
    req.headers['x_e_ts'] ||
    req.headers['x-e-ts'] ||
    ''
  );
  const sig = String(
    req.headers['x-lab-sig'] ||
    req.headers['x_lb_sig'] ||
    req.headers['x-entr-sig'] ||
    req.headers['x_e_sig'] ||
    req.headers['x-e-sig'] ||
    ''
  );
  return { ts, sig };
}

router.post('/crear-codigo-descuento', async (req, res) => {
  try {
    // ── API KEY (opcional, si la config existe)
    if (API_KEY) {
      const inKey = String(req.headers['x-api-key'] || '').trim();
      if (inKey !== API_KEY) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    // ── HMAC (según flag global)
    if (REQUIRE_HMAC) {
      if (!HSEC) return res.status(500).json({ ok: false, error: 'HMAC_SECRET_MISSING' });

      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const path = req.path;

      // Verificación principal (la lib ya sabe leer headers si se los pasamos)
      let v = verifyHmac({
        method: 'POST',
        path,
        bodyRaw: raw,
        headers: req.headers,
        secret: HSEC
      });

      // Fallback si falla por skew y/o por formato legacy (ts.sha256(body))
      if (!v.ok && String(v.error || '').toLowerCase() === 'missing_headers') {
        // Inyectar alias mínimos por si el verificador solo mira x-lab-*
        const { ts, sig } = getSigHeaders(req);
        if (!ts || !sig) {
          return res.status(401).json({ ok: false, error: 'HMAC_INVALID', detail: 'missing_headers' });
        }
        v = verifyHmac({
          method: 'POST',
          path,
          bodyRaw: raw,
          headers: { 'x-lab-ts': ts, 'x-lab-sig': sig }, // normalizamos alias
          secret: HSEC
        });
      }

      if (!v.ok && String(v.error || '').toLowerCase() === 'skew') {
        // toleramos ms/seg y legacy
        try {
          const crypto = require('crypto');
          const tsHdr = getSigHeaders(req).ts;
          const sigHdr = getSigHeaders(req).sig;
          const tsNum = Number(tsHdr);
          const tsSec = (tsNum > 1e11) ? Math.floor(tsNum / 1000) : tsNum;
          const nowSec = Math.floor(Date.now() / 1000);
          const maxSkew = Number(process.env.LAB_HMAC_SKEW_SECS || 900);
          const within = Math.abs(nowSec - tsSec) <= maxSkew;
          const rawHash = crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');

          const expectLegacy = crypto.createHmac('sha256', HSEC).update(`${tsSec}.${rawHash}`).digest('hex');
          const expectV2     = crypto.createHmac('sha256', HSEC).update(`${tsSec}.POST.${path}.${rawHash}`).digest('hex');

          if (within && (sigHdr === expectLegacy || sigHdr === expectV2)) v = { ok: true };
        } catch (_) {}
      }

      if (!v.ok) {
        return res.status(401).json({ ok: false, error: 'HMAC_INVALID', detail: v.error });
      }
    }

    const { nombre, email, codigo, valor, otorganteEmail } = req.body || {};
    if (!nombre || !email || !codigo || !valor) {
      return res.status(400).json({ ok: false, error: 'FALTAN_DATOS' });
    }

    const result = await crearCodigoDescuento({ nombre, email, codigo, valor, otorganteEmail });
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ ok: false, error: 'YA_EXISTE' });
    }
    try {
      await alertAdmin({ area: 'descuentos.crear.error', email: req.body?.email || '-', err, meta: { body: req.body || {} } });
    } catch (_) {}
    console.error('❌ [crear-codigo-descuento] Error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'ERROR_INTERNO' });
  }
});

module.exports = router;
