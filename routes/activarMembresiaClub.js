// routes/activarMembresiaClub.js

const { activarMembresiaClub } = require('../services/activarMembresiaClub');
const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Falta o email inválido' });
  }

  try {
    await activarMembresiaClub(email);
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error al activar la membresía:', error && error.message ? error.message : error);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

module.exports = router;
