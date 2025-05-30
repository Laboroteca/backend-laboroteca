require('dotenv').config();
console.log('📦 WEBHOOK CARGADO');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const handleStripeEvent = require('../services/handleStripeEvent'); // ✅ Función centralizada

module.exports = async function (req, res) {
  console.log('🔥 LLEGÓ AL WEBHOOK');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('🎯 Webhook verificado correctamente');
  } catch (err) {
    console.error('❌ Firma inválida del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const result = await handleStripeEvent(event);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    console.error('❌ Error al manejar evento Stripe:', error);
    return res.status(500).json({ error: 'Error al manejar evento Stripe' });
  }
};