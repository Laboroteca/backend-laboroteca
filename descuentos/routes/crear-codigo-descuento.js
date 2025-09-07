// 📂 descuentos/routes/crear-codigo-descuento.js
'use strict';

const express = require('express');
const router = express.Router();

const { crearCodigoDescuento } = require('../services/crear-descuento');
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ============================================================
 *   POST /descuentos/crear-codigo-descuento
 *   - Protegido por HMAC (LAB_REQUIRE_HMAC=1)
 *   - Idempotente: si ya existe, devuelve {idempotente: true}
 *   - Rate limit aplicado en index.js
 *   - Logs seguros (sin exponer secretos)
 * ============================================================ */
router.post('/crear-codigo-descuento', async (req, res) => {
  const REQUIRE_HMAC = (process.env.LAB_REQUIRE_HMAC === '1');
  const SECRET = String(process.env.PAGO_HMAC_SECRET || '').trim();

  try {
    // 🔒 Verificación HMAC si el flag está activo
    if (REQUIRE_HMAC && SECRET) {
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

    const { nombre, email, codigo, valor, otorganteEmail } = req.body || {};

    if (!nombre || !email || !codigo || !valor) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios' });
    }

    const result = await crearCodigoDescuento({
      nombre,
      email,
      codigo,
      valor,
      otorganteEmail
    });

    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'ALREADY_EXISTS') {
      return res.status(409).json({ ok: false, error: 'Código ya existe', idempotente: true });
    }
    console.error('❌ [crear-codigo-descuento] Error:', err?.message || err);
    try {
      await alertAdmin({
        area: 'descuentos.crear.error',
        email: req.body?.otorganteEmail || '-',
        err,
        meta: { codigo: req.body?.codigo || '' }
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
