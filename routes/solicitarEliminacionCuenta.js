// 📁 routes/solicitarEliminacionCuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');
const { enviarEmailValidacionEliminacionCuenta } = require('../services/email');
const fetch = require('node-fetch');

router.post('/solicitar-eliminacion', async (req, res) => {
  const { email, password } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ ok: false, mensaje: 'Email inválido.' });
  }

  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ ok: false, mensaje: 'Contraseña requerida.' });
  }

  try {
    // Verificar credenciales en WordPress
    const respuesta = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const datos = await respuesta.json();

    if (!datos?.ok) {
      let mensaje = datos.mensaje || '';
      if (mensaje.toLowerCase().includes('contraseña')) {
        mensaje = 'Contraseña incorrecta';
      }
      return res.status(401).json({ ok: false, mensaje: mensaje || 'Contraseña incorrecta' });
    }

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
