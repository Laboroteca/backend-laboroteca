const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Falta el email' });
  }

  try {
    const admin = require('../firebase');
    const firestore = admin.firestore();

    const ref = firestore.collection('usuariosClub').doc(email);

    await ref.set({
      email,
      activo: true,
      fechaAlta: new Date().toISOString()
    }, { merge: true });

    console.log(`✅ Membresía del Club activada para ${email}`);
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error al activar la membresía:', error.message);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

module.exports = router;
