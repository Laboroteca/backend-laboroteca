const express = require('express');
const router = express.Router();

const Stripe = require('stripe');
const admin = require('../firebase');
const handleStripeEvent = require('../services/handleStripeEvent');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { syncMemberpressLibro } = require('../services/syncMemberpressLibro'); // Nuevo, crear este servicio igual que el del club

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const firestore = admin.firestore();
const MEMBERPRESS_CLUB_ID = 10663;
const MEMBERPRESS_LIBRO_ID = 7994;

console.log('📦 WEBHOOK CARGADO');

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    console.log('🛎️ Stripe webhook recibido:', {
      headers: req.headers,
      body: req.body && req.body.length ? req.body.toString('utf8') : '[empty]'
    });
  } catch (logErr) {}

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
    const eventId = event.id;
    const processedRef = firestore.collection('stripeWebhookProcesados').doc(eventId);

    const alreadyProcessed = await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(processedRef);
      if (doc.exists) return true;
      transaction.set(processedRef, {
        type: event.type,
        fecha: new Date().toISOString()
      });
      return false;
    });

    if (alreadyProcessed) {
      console.warn(`⛔️ [WEBHOOK] Evento duplicado ignorado: ${eventId}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    let result;

    switch (event.type) {
      case 'checkout.session.completed': {
        result = await handleStripeEvent(event);
        const session = event.data.object;
        const email =
          session.metadata?.email_autorelleno ||
          session.metadata?.email ||
          session.customer_details?.email || '';
        const nombreProducto =
          (session.metadata?.nombreProducto || '').toLowerCase();

        if (email && nombreProducto === 'el club laboroteca') {
          const actRef = firestore.collection('clubActivaciones').doc(email);
          const actDoc = await actRef.get();
          if (!actDoc.exists) {
            await syncMemberpressClub({
              email,
              accion: 'activar',
              membership_id: MEMBERPRESS_CLUB_ID
            });
            await actRef.set({ activado: true, fecha: new Date().toISOString() });
          } else {
            console.log(`⚠️ Club ya activado para ${email}`);
          }
        }

        // 🔴 ACTIVAR LIBRO SI SE COMPRA EL LIBRO
        if (email && nombreProducto === 'de-cara-a-la-jubilacion') {
          const libroRef = firestore.collection('libroActivaciones').doc(email);
          const libroDoc = await libroRef.get();
          if (!libroDoc.exists) {
            await syncMemberpressLibro({
              email,
              accion: 'activar',
              membership_id: MEMBERPRESS_LIBRO_ID
            });
            await libroRef.set({ activado: true, fecha: new Date().toISOString() });
          } else {
            console.log(`⚠️ Libro ya activado para ${email}`);
          }
        }

        return res.status(200).json({ received: true, ...result });
      }

      case 'customer.subscription.deleted': {
        result = await handleStripeEvent(event);
        const subscription = event.data.object;
        let email = '';
        try {
          if (subscription.customer) {
            const customer = await stripe.customers.retrieve(subscription.customer);
            email = customer?.email || '';
          }
        } catch (e) {
          email = '';
        }
        const nombreProducto =
          (subscription.metadata?.nombreProducto || '').toLowerCase() ||
          (subscription.items?.data?.[0]?.description || '').toLowerCase();

        if (email && nombreProducto.includes('club laboroteca')) {
          const bajaRef = firestore.collection('clubBajas').doc(email);
          const bajaDoc = await bajaRef.get();
          if (!bajaDoc.exists) {
            await syncMemberpressClub({
              email,
              accion: 'desactivar',
              membership_id: MEMBERPRESS_CLUB_ID
            });
            await bajaRef.set({ baja: true, fecha: new Date().toISOString() });
          } else {
            console.log(`⚠️ Baja ya procesada para ${email}`);
          }
        }

        return res.status(200).json({ received: true, ...result });
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const email =
          invoice.metadata?.email_autorelleno ||
          invoice.metadata?.email ||
          invoice.customer_email ||
          (invoice.customer_details && invoice.customer_details.email);

        const esClub =
          (invoice.lines?.data?.some(line =>
            (line.description || '').toLowerCase().includes('club laboroteca')
          )) || (invoice.metadata?.nombreProducto || '').toLowerCase() === 'el club laboroteca';

        if (email && esClub) {
          const renoRef = firestore.collection('renovacionesClub').doc(invoice.id);
          const renoDoc = await renoRef.get();
          if (!renoDoc.exists) {
            await renoRef.set({
              email,
              fecha: new Date().toISOString(),
              evento: 'renovacion-club',
              stripeInvoiceId: invoice.id,
              importe: invoice.amount_paid / 100
            });
          } else {
            console.log(`⚠️ Renovación club ya registrada para ${invoice.id}`);
          }
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
    console.error('❌ Error al manejar evento Stripe:', err.stack || err);
    return res.status(500).json({ error: 'Error al manejar evento Stripe' });
  }
});

module.exports = router;
