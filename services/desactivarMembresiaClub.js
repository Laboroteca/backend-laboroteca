// 📁 services/desactivarMembresiaClub.js
const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { alertAdmin } = require('../utils/alertAdmin');  // 👈 añadido

const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);

async function desactivarMembresiaClub(email, password, enviarEmailConfirmacion = true) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }

  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }

  email = email.trim().toLowerCase();

  // ✅ Paso 0: Validar credenciales
  try {
    const resp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      email,
      password
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LABOROTECA_API_KEY,
      }
    });

    console.log(`[BajaClub] 🔐 Respuesta de validación WP para ${email}:`, resp.data);

    if (!resp.data?.ok) {
      const msg = resp.data?.mensaje || 'Credenciales no válidas';
      console.warn(`[BajaClub] ❌ Validación incorrecta para ${email}: ${msg}`);
      return { ok: false, mensaje: 'Contraseña incorrecta' };
    }
  } catch (err) {
    const msg = err?.response?.data?.mensaje || err.message || 'Error al validar credenciales.';
    console.error(`[BajaClub] ❌ Error validando en WP: ${msg}`);
    await alertAdmin({
      area: 'desactivarMembresiaClub_login',
      email,
      err,
      meta: { email }
    });
    return { ok: false, mensaje: 'Contraseña incorrecta' };
  }

  console.log(`[BajaClub] 🔄 Iniciando proceso de baja para ${email}`);

  // 🔻 1. Cancelar suscripciones activas en Stripe
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
    await alertAdmin({
      area: 'desactivarMembresiaClub_stripe',
      email,
      err,
      meta: { email }
    });
  }

  // 🔻 2. Marcar como inactivo en Firestore
  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    await ref.set({
      activo: false,
      fechaBaja: new Date().toISOString()
    }, { merge: true });
    console.log(`📉 Firestore: usuario marcado como inactivo`);
  } catch (err) {
    console.error(`❌ Error en Firestore:`, err.message);
    await alertAdmin({
      area: 'desactivarMembresiaClub_firestore',
      email,
      err,
      meta: { email }
    });
  }

  // 🔻 3. Desactivar en MemberPress
  try {
    const mpResp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: MEMBERSHIP_ID
    });
    console.log(`🧩 MemberPress desactivado`, mpResp);
    if (!mpResp.ok) {
      await alertAdmin({
        area: 'desactivarMembresiaClub_memberpress',
        email,
        err: new Error(mpResp?.error || 'Fallo al desactivar'),
        meta: { email }
      });
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${mpResp?.error || 'Sin mensaje'}` };
    }
  } catch (err) {
    console.error(`❌ Error en MemberPress:`, err.message);
    await alertAdmin({
      area: 'desactivarMembresiaClub_memberpress_catch',
      email,
      err,
      meta: { email }
    });
    return { ok: false, mensaje: `Error al desactivar en MemberPress: ${err.message}` };
  }

  // 🔻 4. Email de confirmación (solo si es baja voluntaria o eliminación)
  if (enviarEmailConfirmacion) {
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
      await alertAdmin({
        area: 'desactivarMembresiaClub_email_baja',
        email,
        err,
        meta: { email }
      });
    }
  }

  return { ok: true, cancelada: true };
}

module.exports = desactivarMembresiaClub;
