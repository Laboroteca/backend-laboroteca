// 📁 services/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);

/**
 * Desactiva la membresía del Club Laboroteca (Stripe, Firestore, MemberPress).
 * @param {string} email - Email del usuario
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function desactivarMembresiaClub(email) {
  console.log(`[BajaClub] 🔄 Iniciando proceso de baja para ${email}`);

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }

  // 🔴 1. Cancelar suscripciones activas en Stripe
  try {
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length > 0) {
      const customerId = clientes.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10
      });

      for (const sub of subs.data) {
        if (['active', 'trialing', 'incomplete', 'past_due'].includes(sub.status)) {
          await stripe.subscriptions.cancel(sub.id, {
            invoice_now: false,
            prorate: false
          });
          console.log(`🛑 Stripe: suscripción ${sub.id} cancelada`);
        }
      }

    } else {
      console.warn(`⚠️ Stripe: cliente no encontrado para ${email}`);
    }
  } catch (err) {
    console.error(`❌ Error en Stripe:`, err.message);
  }

  // 🔴 2. Marcar como inactivo en Firestore
  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    await ref.set({
      activo: false,
      fechaBaja: new Date().toISOString()
    }, { merge: true });
    console.log(`📉 Firestore: usuario marcado como inactivo`);
  } catch (err) {
    console.error(`❌ Error en Firestore:`, err.message);
  }

  // 🔴 3. Desactivar en MemberPress
  try {
    const mpResp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: MEMBERSHIP_ID
    });
    console.log(`🧩 MemberPress desactivado`, mpResp);
    if (!mpResp.ok) {
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${mpResp?.error || 'Sin mensaje'}` };
    }
  } catch (err) {
    console.error(`❌ Error en MemberPress:`, err.message);
    return { ok: false, mensaje: `Error al desactivar en MemberPress: ${err.message}` };
  }

  // 🔴 4. Email de confirmación
  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    const doc = await ref.get();
    const nombre = doc.exists ? (doc.data()?.nombre || '') : '';

    const resultadoEmail = await enviarConfirmacionBajaClub(email, nombre);
    if (resultadoEmail?.data?.succeeded === 1) {
      console.log(`📩 Email de baja enviado a ${email}`);
    } else {
      console.warn(`⚠️ Email no confirmado para ${email}`);
    }
  } catch (err) {
    console.error(`❌ Error al enviar email de baja:`, err.message);
  }

  return { ok: true };
}

module.exports = desactivarMembresiaClub;
