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
    const token = crypto.randomBytes(32).toString('hex');
    const ahora = Date.now();
    const expira = ahora + 1000 * 60 * 60 * 2; // 2 horas

    // Guardar token en Firestore
    await firestore.collection('eliminacionCuentas').doc(token).set({
      email,
      expira
    });

    // Enviar email con enlace de validación
    await enviarEmailValidacionEliminacionCuenta(email, token);

    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ Error al solicitar eliminación de cuenta:', err);
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
