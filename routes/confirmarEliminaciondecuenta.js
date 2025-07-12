// 📁 routes/confirmarEliminaciondecuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();

const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const desactivarMembresiaClub = require('../services/desactivarMembresiaClub');
const { borrarDatosUsuarioFirestore } = require('../services/borrarDatosUsuarioFirestore');
const { enviarEmailPersonalizado } = require('../services/email');

// ✅ POST /confirmar-eliminacion
router.post('/confirmar-eliminacion', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ ok: false, mensaje: 'Falta el token de verificación.' });
  }

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, mensaje: 'El enlace no es válido o ya ha sido utilizado.' });
    }

    const { email, expira } = snap.data();
    const ahora = Date.now();

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, mensaje: 'Email no válido.' });
    }

    if (!expira || ahora > expira) {
      await ref.delete();
      return res.status(410).json({ ok: false, mensaje: 'El enlace ha caducado.' });
    }

    // ✅ Desactivar membresías y eliminar datos
    await desactivarMembresiaClub(email);
    await eliminarUsuarioWordPress(email); // sin contraseña
    await borrarDatosUsuarioFirestore(email);
    await ref.delete();

    await enviarEmailPersonalizado({
      to: email,
      subject: 'Cuenta eliminada con éxito',
      html: `
        <p><strong>✅ Tu cuenta en Laboroteca ha sido eliminada correctamente.</strong></p>
        <p>Gracias por habernos acompañado. Si alguna vez decides volver, estaremos encantados de recibirte.</p>
      `,
      text: 'Tu cuenta en Laboroteca ha sido eliminada correctamente. Gracias por tu confianza.',
      enviarACopy: true
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ Error al confirmar eliminación:', err);
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
