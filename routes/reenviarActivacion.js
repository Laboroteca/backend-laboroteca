const admin = require('../firebase');
const firestore = admin.firestore();
const { enviarEmailActivacion } = require('../services/email');
const crypto = require('crypto');

module.exports = async function (req, res) {
  const email = req.body?.email?.toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: 'Email requerido.' });
  }

  try {
    const docRef = firestore.collection('usuariosPendientes').doc(email);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'No hay registro pendiente para este email.' });
    }

    const datos = doc.data();

    if (datos.activado === 'sí') {
      return res.status(400).json({ error: 'Este usuario ya está activado.' });
    }

    // Usar el token existente o crear uno nuevo si no existía
    let { token } = datos;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await docRef.update({ token });
    }

    await enviarEmailActivacion(email, token, datos.nombre || '');

    return res.status(200).json({ ok: true, mensaje: 'Email de activación reenviado correctamente.' });
  } catch (error) {
    console.error('❌ Error al reenviar email de activación:', error.message);
    return res.status(500).json({ error: 'Error interno al reenviar el email.' });
  }
};
