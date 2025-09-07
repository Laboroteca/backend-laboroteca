// 📂 descuentos/routes/crear-codigo-descuento.js
'use strict';

const express = require('express');
const router = express.Router();

const { crearCodigoDescuento } = require('../services/crear-descuento'); // ✅ nombre correcto
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const REQUIRE_HMAC = process.env.LAB_REQUIRE_HMAC === '1';
const HSEC = String(
  process.env.DESCUENTOS_HMAC_SECRET ||
  process.env.ENTRADAS_HMAC_SECRET ||
  ''
).trim();
const API_KEY = String(
  process.env.DESCUENTOS_API_KEY ||
  process.env.ENTRADAS_API_KEY ||
  ''
).trim();
const LAB_DEBUG = process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1';

// ---- helpers
function pickTs(req) {
  return String(
    req.headers['x-lab-ts']  || req.headers['x_lb_ts'] ||
    req.headers['x-entr-ts'] || req.headers['x_entr_ts'] ||
    req.headers['x-e-ts']    || req.headers['x_e_ts'] ||
    ''
  );
}
function pickSig(req) {
  return String(
    req.headers['x-lab-sig']  || req.headers['x_lb_sig'] ||
    req.headers['x-entr-sig'] || req.headers['x_entr_sig'] ||
    req.headers['x-e-sig']    || req.headers['x_e_sig'] ||
    ''
  );
}
function getRaw(req) {
  return req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
}
function getSignedPath(req) {
  // pathname completo (incluye el prefijo /descuentos)
  return new URL(req.originalUrl || req.url, 'http://x').pathname;
}

router.post('/crear-codigo-descuento', async (req, res) => {
  try {
    // ── API KEY (si está configurada)
    if (API_KEY) {
      const inKey = String(req.headers['x-api-key'] || '').trim();
      if (inKey !== API_KEY) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    // ── HMAC
    if (REQUIRE_HMAC) {
      if (!HSEC) return res.status(500).json({ ok:false, error:'HMAC_SECRET_MISSING' });

      const raw  = getRaw(req);
      const path = getSignedPath(req);     // ✅ coincide con lo firmado en WP
      const ts   = pickTs(req);
      const sig  = pickSig(req);

      if (!ts || !sig) {
        return res.status(401).json({ ok:false, error:'HMAC_INVALID', detail:'missing_headers' });
      }

      // 1) Intento con verifyHmac (normalizamos a x-lab-*)
      let v = verifyHmac({
        method: 'POST',
        path,
        bodyRaw: raw,
        headers: { 'x-lab-ts': ts, 'x-lab-sig': sig }, // alias → canonical
        secret: HSEC
      });

      // 2) Fallback manual: v2/v1 con ts en ms o en s
      if (!v.ok) {
        try {
          const crypto = require('crypto');
          const bodyHash = crypto.createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
          const tsNum = Number(ts);
          const tsSec = tsNum > 1e11 ? Math.floor(tsNum / 1000) : tsNum;

          const candidates = [
            `${tsSec}.POST.${path}.${bodyHash}`,  // v2 + seconds
            `${tsNum}.POST.${path}.${bodyHash}`,  // v2 + millis
            `${tsSec}.${bodyHash}`,               // legacy + seconds
            `${tsNum}.${bodyHash}`                // legacy + millis
          ];
          const okManual = candidates.some(base =>
            crypto.createHmac('sha256', HSEC).update(base).digest('hex') === sig
          );

          if (LAB_DEBUG && !okManual) {
            console.warn('[DESC HMAC] BAD_SIG', { path, ts, bodyHash10: bodyHash.slice(0,10) });
          }

          if (!okManual) {
            return res.status(401).json({ ok:false, error:'HMAC_INVALID', detail:'bad_sig' });
          }
        } catch (e) {
          return res.status(401).json({ ok:false, error:'HMAC_INVALID', detail:'fallback_error' });
        }
      }
    }

    // ── Validación mínima del payload
    const { nombre, email, codigo, valor, otorganteEmail } = req.body || {};
    if (!nombre || !email || !codigo || !valor) {
      return res.status(400).json({ ok:false, error:'FALTAN_DATOS' });
    }

    const result = await crearCodigoDescuento({ nombre, email, codigo, valor, otorganteEmail });
    return res.status(201).json({ ok:true, ...result });
  } catch (err) {
    if (err && err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ ok:false, error:'YA_EXISTE' });
    }
    try {
      await alertAdmin({
        area: 'descuentos.crear.error',
        email: (req.body && req.body.email) || '-',
        err,
        meta: { bodyKeys: Object.keys(req.body || {}) }
      });
    } catch (_) {}
    console.error('❌ [crear-codigo-descuento]', err?.message || err);
    return res.status(500).json({ ok:false, error:'ERROR_INTERNO' });
  }
});

module.exports = router;
