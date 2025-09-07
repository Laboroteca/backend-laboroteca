// 📂 descuentos/routes/crear-codigo-descuento.js
'use strict';

const express = require('express');
const router = express.Router();

const { crearCodigoDescuento } = require('../services/crear-codigo-descuento'); // <- service real
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const REQUIRE_HMAC = process.env.LAB_REQUIRE_HMAC === '1';
const HSEC = String(
  process.env.DESCUENTOS_HMAC_SECRET ||
  process.env.ENTRADAS_HMAC_SECRET || // compat
  ''
).trim();

const API_KEY = String(
  process.env.DESCUENTOS_API_KEY ||
  process.env.ENTRADAS_API_KEY || // compat
  ''
).trim();

// Lee alias de headers (x-lab-*, x-entr-*, x-e-*)
function pickSigHeaders(req) {
  const h = req.headers || {};
  const ts =
    String(h['x-lab-ts'] || h['x_lb_ts'] ||
           h['x-entr-ts'] || h['x_e_ts'] ||
           h['x-e-ts'] || '')
      .trim();

  const sig =
    String(h['x-lab-sig'] || h['x_lb_sig'] ||
           h['x-entr-sig'] || h['x_e_sig'] ||
           h['x-e-sig'] || '')
      .trim();

  const reqId =
    String(h['x-request-id'] || h['x_request_id'] || '')
      .trim()
    || `gen_${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;

  return { ts, sig, reqId };
}

router.post('/crear-codigo-descuento', async (req, res) => {
  try {
    // ── API KEY (opcional: si está configurada, la exigimos)
    if (API_KEY) {
      const inKey = String(req.headers['x-api-key'] || '').trim();
      if (inKey !== API_KEY) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }
    }

    // ── HMAC (según flag global)
    if (REQUIRE_HMAC) {
      if (!HSEC) {
        return res.status(500).json({ ok:false, error:'HMAC_SECRET_MISSING' });
      }

      // Body EXACTO (buffer) y path COMPLETO montado (coincide con lo firmado en WP)
      const raw  = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
      const path = new URL(req.originalUrl || req.url, 'http://x').pathname;

      // Normalizamos cabeceras a x-lab-* y garantizamos x-request-id
      const { ts, sig, reqId } = pickSigHeaders(req);
      const hdrs = {
        'x-lab-ts': ts,
        'x-lab-sig': sig,
        'x-request-id': reqId
      };

      let v = verifyHmac({
        method: 'POST',
        path,
        bodyRaw: raw,
        headers: { ...req.headers, ...hdrs }, // mantenemos también las originales
        secret: HSEC
      });

      // Tolerancia extra si el verificador devuelve skew (ms/seg o v1/legacy)
      if (!v.ok && String(v.error || '').toLowerCase() === 'skew') {
        try {
          const crypto = require('crypto');
          const tsNum  = Number(ts);
          const tsSec  = (tsNum > 1e11) ? Math.floor(tsNum / 1000) : tsNum;
          const nowSec = Math.floor(Date.now() / 1000);
          const maxSkew = Number(process.env.LAB_HMAC_SKEW_SECS || 900);
          const within  = Math.abs(nowSec - tsSec) <= maxSkew;
          const rawHash = crypto.createHash('sha256').update(raw).digest('hex');

          const expectV1 = crypto.createHmac('sha256', HSEC).update(`${tsSec}.${rawHash}`).digest('hex');                 // ts.sha256(body)
          const expectV2 = crypto.createHmac('sha256', HSEC).update(`${tsSec}.POST.${path}.${rawHash}`).digest('hex');    // ts.POST.<path>.sha256(body)

          if (within && (sig === expectV1 || sig === expectV2)) v = { ok: true };
        } catch (_) {}
      }

      if (!v.ok) {
        return res.status(401).json({ ok:false, error:'HMAC_INVALID', detail: v.error });
      }
    }

    // ── Validación de payload
    const { nombre, email, codigo, valor, otorganteEmail } = req.body || {};
    if (!nombre || !email || !codigo || !valor) {
      return res.status(400).json({ ok:false, error:'FALTAN_DATOS' });
    }

    // ── Crear (service idempotente)
    const result = await crearCodigoDescuento({ nombre, email, codigo, valor, otorganteEmail });
    return res.status(201).json({ ok:true, ...result });

  } catch (err) {
    if (err && err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ ok:false, error:'YA_EXISTE' });
    }
    try {
      await alertAdmin({
        area: 'descuentos.crear.error',
        email: (req.body?.email || '-'),
        err,
        meta: { bodyKeys: Object.keys(req.body || {}) }
      });
    } catch (_) {}
    console.error('❌ [crear-codigo-descuento] Error:', err?.message || err);
    return res.status(500).json({ ok:false, error:'ERROR_INTERNO' });
  }
});

module.exports = router;
