// 📂 descuentos/routes/validar-descuento.js
'use strict';

const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();
const { verifyHmac } = require('../../utils/verifyHmac');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const router = express.Router();

/**
 * POST /descuentos/validar-descuento
 * - Entrada: { codigo }
 * - Salida: { ok, valido, usado, valorEur }
 * - Seguridad: HMAC opcional según LAB_REQUIRE_HMAC
 */
router.post('/validar-descuento', async (req, res) => {
  const REQUIRE_HMAC = (process.env.LAB_REQUIRE_HMAC === '1');
  const SECRET = String(process.env.PAGO_HMAC_SECRET || '').trim();

  try {
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (REQUIRE_HMAC && SECRET) {
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
    if (!/^DSC-[A-Z0-9]{5}$/.test(codigo)) {
      return res.json({ ok: true, valido: false, error: 'FORMATO_INVALIDO' });
    }

    const snap = await firestore.collection('codigosDescuento').doc(codigo).get();
    if (!snap.exists) {
      return res.json({ ok: true, valido: false, error: 'NO_EXISTE' });
    }

    const data = snap.data() || {};
    const usado = !!data.usado;
    const valorEur = Number(data.valor) || 0;

    return res.json({
      ok: true,
      valido: !usado && valorEur > 0,
      usado,
      valorEur
    });
  } catch (err) {
    console.error('❌ validar-descuento error:', err?.message || err);
    try {
      await alertAdmin({
        area: 'descuentos.validar.error',
        email: req.body?.email || '-',
        err,
        meta: { codigo: req.body?.codigo || '' }
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
