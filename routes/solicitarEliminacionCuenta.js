// 📁 routes/solicitarEliminacionCuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');
const { enviarEmailValidacionEliminacionCuenta } = require('../services/email');

router.post('/solicitar-eliminacion', async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ ok: false, mensaje: 'Email inválido.' });
  }

  try {
    // 1. Generar token aleatorio único (hex) y fecha de expiración
    const token = crypto.randomBytes(32).toString('hex');
    const ahora = Date.now();
    const expira = ahora + 1000 * 60 * 60 * 2; // 2 horas

    // 2. Guardar token en Firestore con email y fecha de expiración
    await firestore.collection('eliminacionCuentas').doc(token).set({
      email,
      expira
    });

    // 3. Enviar email con enlace de validación
    await enviarEmailValidacionEliminacionCuenta(email, token);

    // 4. Respuesta OK
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error al solicitar eliminación de cuenta:', err);
    return res.status(500).json({
      ok: false,
      mensaje: 'Error interno del servidor.'
    });
  }
});

module.exports = router;
