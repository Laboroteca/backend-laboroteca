const express = require('express');
const router = express.Router();

const Stripe = require('stripe');
const admin = require('../firebase');
const handleStripeEvent = require('../services/handleStripeEvent');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const firestore = admin.firestore();
const MEMBERPRESS_CLUB_ID = 10663;

console.log('📦 WEBHOOK CARGADO');

// ✅ Middleware del webhook de Stripe
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
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
      case 'checkout.session.completed': {
        result = await handleStripeEvent(event);
        const session = event.data.object;
        const email =
          session.metadata?.email_autorelleno ||
          session.metadata?.email ||
          session.customer_details?.email;

        const nombreProducto =
          session.metadata?.nombreProducto ||
          session?.display_items?.[0]?.custom?.name;

        if (
          email &&
          nombreProducto?.toLowerCase() === 'el-club-laboroteca'
        ) {
          await syncMemberpressClub({
            email,
            accion: 'activar',
            membership_id: MEMBERPRESS_CLUB_ID
          });
        }

        return res.status(200).json({ received: true, ...result });
      }

      case 'customer.subscription.deleted': {
        result = await handleStripeEvent(event);
        const subscription = event.data.object;
        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer?.email;
        const nombreProducto =
          subscription.metadata?.nombreProducto ||
          subscription.items?.data?.[0]?.description;

        if (
          email &&
          nombreProducto?.toLowerCase().includes('club laboroteca')
        ) {
          await syncMemberpressClub({
            email,
            accion: 'desactivar',
            membership_id: MEMBERPRESS_CLUB_ID
          });
        }

        return res.status(200).json({ received: true, ...result });
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const email =
          invoice.metadata?.email_autorelleno ||
          invoice.metadata?.email ||
          invoice.customer_email ||
          invoice.customer_details?.email;

        const esClub =
          invoice.lines?.data?.some(line =>
            line.description?.toLowerCase().includes('club laboroteca')
          ) || invoice.metadata?.nombreProducto === 'el-club-laboroteca';

        if (email && esClub) {
          await firestore.collection('renovacionesClub').add({
            email,
            fecha: new Date().toISOString(),
            evento: 'renovacion-club',
            stripeInvoiceId: invoice.id,
            importe: invoice.amount_paid / 100
          });
        }

        return res.status(200).json({ received: true });
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'payment_intent.succeeded': {
        result = await handleStripeEvent(event);
        return res.status(200).json({ received: true, ...result });
      }

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
        return res.status(200).json({ received: true });
    }
  } catch (err) {
    console.error('❌ Error al manejar evento Stripe:', err);
    return res.status(500).json({ error: 'Error al manejar evento Stripe' });
  }
});

module.exports = router;
