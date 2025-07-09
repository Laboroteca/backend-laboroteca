// 📁 routes/confirmarEliminaciondecuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const { enviarEmailPersonalizado } = require('../services/email');

// ✅ GET /confirmar-eliminacion?token=abc123
router.get('/confirmar-eliminacion', async (req, res) => {
  const token = req.query.token;
  const password = req.query.password;

  if (!token || !password) {
    return res.status(400).send('Faltan datos: token o contraseña.');
  }

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).send('El enlace no es válido o ya ha sido utilizado.');
    }

    const { email, expira } = snap.data();
    const ahora = Date.now();

    if (ahora > expira) {
      await ref.delete();
      return res.status(410).send('El enlace ha caducado.');
    }

    // 🔴 Lógica de baja: Stripe, MemberPress y WordPress
    await desactivarMembresiaClub(email);
    await eliminarUsuarioWordPress(email, password);
    await ref.delete();

    await enviarEmailPersonalizado({
      to: email,
      subject: 'Cuenta eliminada con éxito',
      html: `
        <p>Tu cuenta en Laboroteca ha sido eliminada correctamente.</p>
        <p>Gracias por habernos acompañado. Si alguna vez decides volver, estaremos encantados de recibirte.</p>
      `,
      text: 'Tu cuenta en Laboroteca ha sido eliminada correctamente. Gracias por tu confianza.',
      enviarACopy: true
    });

    return res.send('✅ Tu cuenta ha sido eliminada correctamente. Puedes cerrar esta ventana.');
  } catch (err) {
    console.error('❌ Error al confirmar eliminación:', err);
    return res.status(500).send('Error interno del servidor.');
  }
});

module.exports = router;
