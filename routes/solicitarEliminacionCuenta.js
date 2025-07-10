const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const { enviarEmailPersonalizado } = require('../services/email');
const crypto = require('crypto');

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

    // Construir enlace
    const url = `https://www.laboroteca.es/confirmar-eliminacion?token=${token}`;

    // Enviar email
    await enviarEmailPersonalizado({
      to: email,
      subject: 'Confirma la eliminación de tu cuenta',
      html: `
        <p>Has solicitado eliminar tu cuenta de Laboroteca.</p>
        <p>Para confirmar la eliminación definitiva, haz clic en el siguiente botón:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${url}" style="background: #c62828; color: white; padding: 14px 24px; font-size: 18px; font-weight: bold; text-decoration: none; border-radius: 8px;">
            Confirmar eliminación de cuenta
          </a>
        </p>
        <p>Este enlace caduca en 2 horas.</p>
      `,
      text: `Has solicitado eliminar tu cuenta de Laboroteca. Para confirmarlo, visita: ${url}`,
      enviarACopy: true
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ Error al solicitar eliminación de cuenta:', err);
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
