require('dotenv').config();
console.log('📦 WEBHOOK CARGADO');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const admin = require('../firebase');
const firestore = admin.firestore();

const handleStripeEvent = require('../services/handleStripeEvent');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

const MEMBERPRESS_CLUB_ID = 10663;

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
          const email =
            session.metadata?.email_autorelleno ||
            session.metadata?.email ||
            session.customer_details?.email;

          if (
            email &&
            (session.metadata?.nombreProducto === 'el-club-laboroteca' ||
              session?.display_items?.[0]?.custom?.name === 'El Club Laboroteca')
          ) {
            await syncMemberpressClub({
              email,
              accion: 'activar',
              membership_id: MEMBERPRESS_CLUB_ID
            });
          }
        } catch (err) {
          console.error('❌ Error al activar en MemberPress:', err);
        }
        return res.status(200).json({ received: true, ...result });

      case 'customer.subscription.deleted':
        result = await handleStripeEvent(event);
        try {
          const subscription = event.data.object;
          const email =
            subscription.metadata?.email_autorelleno ||
            subscription.metadata?.email ||
            subscription.customer_email;

          if (
            email &&
            (subscription.metadata?.nombreProducto === 'el-club-laboroteca' ||
              subscription?.items?.data?.[0]?.description?.includes('Club Laboroteca'))
          ) {
            await syncMemberpressClub({
              email,
              accion: 'desactivar',
              membership_id: MEMBERPRESS_CLUB_ID
            });
          }
        } catch (err) {
          console.error('❌ Error al desactivar en MemberPress:', err);
        }
        return res.status(200).json({ received: true, ...result });

      case 'invoice.paid':
        try {
          const invoice = event.data.object;
          const email =
            invoice.metadata?.email_autorelleno ||
            invoice.metadata?.email ||
            invoice.customer_email ||
            invoice.customer_details?.email;

          console.log('💳 invoice.paid recibido para:', email);

          const esClub =
            invoice.lines?.data?.some(line =>
              line.description?.toLowerCase().includes('club laboroteca')
            ) || invoice.metadata?.nombreProducto === 'el-club-laboroteca';

          if (email && esClub) {
            console.log(`📆 Renovación mensual registrada para ${email}`);

            await firestore.collection('renovacionesClub').add({
              email,
              fecha: new Date().toISOString(),
              evento: 'renovacion-club',
              stripeInvoiceId: invoice.id,
              importe: invoice.amount_paid / 100
            });
          }

          return res.status(200).json({ received: true });
        } catch (err) {
          console.error('❌ Error procesando invoice.paid:', err);
          return res.status(500).json({ error: 'Error invoice.paid' });
        }

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
