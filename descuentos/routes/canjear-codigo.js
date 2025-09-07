// 📂 descuentos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const router = express.Router();

const { marcarCodigoComoUsado } = require('../services/canjeo');
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ================== CONFIG ================== */
const REQUIRE_HMAC = (process.env.LAB_REQUIRE_HMAC === '1');
const SECRET = String(process.env.DESCUENTOS_HMAC_SECRET || '').trim();

/* ============================================================
 *   POST /descuentos/canjear-codigo-descuento
 *   - Protegido por HMAC (si LAB_REQUIRE_HMAC=1)
 *   - Idempotente: si ya estaba usado, no rompe
 *   - Rate limit aplicado en index.js
 * ============================================================ */
router.post('/canjear-codigo-descuento', async (req, res) => {
  try {
    // 🔒 Verificar HMAC si está activado
    if (REQUIRE_HMAC) {
      if (!SECRET) {
        return res.status(500).json({ ok: false, error: 'HMAC_SECRET_MISSING' });
      }
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const v = verifyHmac({
        method: 'POST',
        path: req.path,
        bodyRaw: raw,
        headers: req.headers,
        secret: SECRET
      });
      if (!v.ok) {
        return res.status(401).json({ ok: false, error: 'HMAC_INVALID', detail: v.error });
      }
    }

    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    if (!codigo) {
      return res.status(400).json({ ok: false, error: 'FALTA_CODIGO' });
    }

    const resultado = await marcarCodigoComoUsado(codigo);
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('❌ [canjear-codigo-descuento] Error:', err?.message || err);
    try {
      await alertAdmin({
        area: 'descuentos.canjeo.error',
        email: req.body?.email || '-', // por si se manda junto al código
        err,
        meta: { codigo: req.body?.codigo || '(sin codigo)' }
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, error: 'ERROR_INTERNO' });
  }
});

module.exports = router;
