// routes/activarMembresiaClub.js

const { activarMembresiaClub } = require('../services/activarMembresiaClub');
const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Falta el email' });
  }

  try {
    await activarMembresiaClub(email);

    // Aquí puedes añadir lógica adicional si en el futuro quieres notificar por email, etc.

    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error al activar la membresía:', error.message);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

module.exports = router;
