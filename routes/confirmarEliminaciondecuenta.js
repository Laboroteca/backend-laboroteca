// 📁 routes/confirmarEliminaciondecuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();

const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const { borrarDatosUsuarioFirestore } = require('../services/borrarDatosUsuarioFirestore');
const { enviarEmailPersonalizado } = require('../services/email');

// ✅ POST /confirmar-eliminacion
router.post('/confirmar-eliminacion', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ ok: false, mensaje: 'Faltan datos: token o contraseña.' });
  }

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, mensaje: 'El enlace no es válido o ya ha sido utilizado.' });
    }

    const { email, expira } = snap.data();
    const ahora = Date.now();

    if (ahora > expira) {
      await ref.delete();
      return res.status(410).json({ ok: false, mensaje: 'El enlace ha caducado.' });
    }

    // ✅ Primero desactivar membresía
    await desactivarMembresiaClub(email);

    // 🔐 Intentamos eliminar usuario en WordPress (verifica la contraseña)
    const resultado = await eliminarUsuarioWordPress(email, password);

    if (!resultado.ok) {
      return res.status(401).json({ ok: false, mensaje: resultado.mensaje || 'Contraseña incorrecta' });
    }

    // 🧹 Borrar datos en Firestore
    await borrarDatosUsuarioFirestore(email);

    // 🔒 Borrar el token usado
    await ref.delete();

    // 📩 Email de confirmación
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
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor' });
  }
});

module.exports = router;
