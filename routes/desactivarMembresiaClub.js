// routes/desactivarMembresiaClub.js
const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');

module.exports = async function (req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Falta el email' });
    }

    await desactivarMembresiaClub(email);

    // Aquí puedes llamar a más lógica: cancelar en Stripe, FacturaCity, enviar email, etc.

    return res.json({ ok: true, mensaje: 'Baja tramitada correctamente.' });
  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error);
    return res.status(500).json({ error: 'Error al desactivar la membresía' });
  }
};
