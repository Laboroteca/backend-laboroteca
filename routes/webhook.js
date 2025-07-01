require('dotenv').config();
console.log('📦 WEBHOOK CARGADO');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const handleStripeEvent = require('../services/handleStripeEvent');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

module.exports = async function (req, res) {
  console.log('🔥 LLEGÓ AL WEBHOOK');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log(`🎯 Webhook verificado: ${event.type}`);
  } catch (err) {
    console.error('❌ Firma inválida del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    let result;
    switch (event.type) {
      case 'checkout.session.completed':
        result = await handleStripeEvent(event);
        try {
          const session = event.data.object;
          if (
            session?.metadata?.nombreProducto === 'El Club Laboroteca' ||
            (session?.display_items && session.display_items[0]?.custom?.name === 'El Club Laboroteca')
          ) {
            const email = session.customer_details?.email || session.metadata?.email;
            if (email) await syncMemberpressClub({ email, accion: 'activar' });
          }
        } catch (err) {
          console.error('❌ Error al activar en MemberPress:', err);
        }
        return res.status(200).json({ received: true, ...result });

      case 'customer.subscription.deleted':
        result = await handleStripeEvent(event);
        try {
          const subscription = event.data.object;
          const email = subscription?.metadata?.email || subscription?.customer_email;
          if (
            subscription?.metadata?.nombreProducto === 'El Club Laboroteca' ||
            (subscription?.items?.data?.[0]?.description || '').includes('Club Laboroteca')
          ) {
            if (email) await syncMemberpressClub({ email, accion: 'desactivar' });
          }
        } catch (err) {
          console.error('❌ Error al desactivar en MemberPress:', err);
        }
        return res.status(200).json({ received: true, ...result });

      case 'invoice.paid':
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'payment_intent.succeeded':
        result = await handleStripeEvent(event);
        return res.status(200).json({ received: true, ...result });

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
        return res.status(200).json({ received: true });
    }
  } catch (error) {
    console.error('❌ Error al manejar evento Stripe:', error);
    return res.status(500).json({ error: 'Error al manejar evento Stripe' });
  }
};
