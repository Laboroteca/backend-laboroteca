const { desactivarMembresiaClub } = require('../services/desactivarMembresiaClub');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function (req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Falta el email' });
    }

    // 1. Desactivar en Firestore
    await desactivarMembresiaClub(email);

    // 2. Cancelar suscripción activa en Stripe
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: 'Cliente no encontrado en Stripe' });
    }

    const customerId = customers.data[0].id;
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    if (!subs.data.length) {
      return res.status(404).json({ error: 'Suscripción activa no encontrada en Stripe' });
    }

    await stripe.subscriptions.del(subs.data[0].id);

    return res.json({ ok: true, mensaje: 'Baja tramitada correctamente en Firestore y Stripe.' });
  } catch (error) {
    console.error('❌ Error al desactivar membresía:', error);
    return res.status(500).json({ error: 'Error al desactivar la membresía', msg: error.message });
  }
};
