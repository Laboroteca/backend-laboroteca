// routes/desactivarMembresiaClub.js

const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');

module.exports = async function (req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Falta el email' });
    }

    // 1. Desactivar en Firestore
    await desactivarMembresiaClub(email);

    // 2. Aquí puedes:
    // - Cancelar suscripción en Stripe
    // - Cancelar factura recurrente en FacturaCity (si aplica)
    // - Enviar email de confirmación al usuario (lo implementarás después)
    // IMPORTANTE: Pásame aquí la lógica de Stripe o la llamo desde otro service según veas.

    return res.json({ ok: true, mensaje: 'Baja tramitada correctamente.' });
  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error);
    return res.status(500).json({ error: 'Error al desactivar la membresía' });
  }
};
