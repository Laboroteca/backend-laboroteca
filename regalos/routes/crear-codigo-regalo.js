const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();

const router = express.Router();

/**
 * Ruta para crear un código regalo único y asociarlo a un email.
 * Requiere: nombre, email, codigo
 */
router.post('/crear-codigo-regalo', async (req, res) => {
  try {
    const { nombre, email, codigo } = req.body;

    if (!nombre || !email || !codigo) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    if (!codigo.startsWith('REG-')) {
      return res.status(400).json({ error: 'El código debe empezar por REG-.' });
    }

    // 🔎 Buscar si el código ya existe
    const docRef = firestore.collection('codigosRegalo').doc(codigo);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      return res.status(400).json({ error: 'Este código ya ha sido registrado previamente.' });
    }

    // 📝 Guardar en Firestore
    await docRef.set({
      nombre,
      email: email.toLowerCase(),
      codigo,
      creado: new Date().toISOString(),
      usado: false
    });

    console.log(`🎁 Código REGALO creado: ${codigo} para ${email}`);
    res.status(200).json({ ok: true, codigo });
  } catch (err) {
    console.error('❌ Error al crear código regalo:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

module.exports = router;
