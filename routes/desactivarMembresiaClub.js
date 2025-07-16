// 📁 routes/desactivarMembresiaClub.js
// Este archivo se usa para gestionar la baja manual del Club desde formularios web.
// Incluye verificación de contraseña, eliminación opcional de usuario en WordPress y cancelación de Stripe.
// No confundir con services/desactivarMembresiaClub.js, que se usa para cancelaciones automáticas o backend.

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

async function verificarLoginWordPress(email, password) {
  try {
    const res = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!data?.ok) {
      let msg = data.mensaje || '';
      if (msg.toLowerCase().includes('contraseña') || msg.toLowerCase().includes('password')) {
        msg = 'Contraseña incorrecta';
      }
      return { ok: false, mensaje: msg || 'Contraseña incorrecta' };
    }
    return { ok: true };
  } catch (e) {
    console.error('❌ Error conectando a WP para login:', e.message);
    return { ok: false, mensaje: 'No se pudo conectar con WordPress.' };
  }
}

async function desactivarMembresiaClub(email, password) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }

  // 🔒 Siempre exige contraseña válida
  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña requerida.' };
  }

  // Verifica la contraseña con WordPress
  const wpLogin = await verificarLoginWordPress(email, password);
  if (!wpLogin.ok) {
    return { ok: false, mensaje: wpLogin.mensaje || 'Contraseña incorrecta' };
  }

  // 🔻 Paso 1: Cancelar suscripciones activas en Stripe
  try {
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length === 0) {
      console.warn(`⚠️ Stripe: cliente no encontrado para ${email}`);
    } else {
      const customerId = clientes.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10
      });

      const suscripcionesCanceladas = [];

      for (const sub of subs.data) {
        if (['active', 'trialing', 'incomplete', 'past_due'].includes(sub.status)) {
          await stripe.subscriptions.cancel(sub.id, {
            invoice_now: false,
            prorate: false
          });
          console.log(`🛑 Stripe: suscripción ${sub.id} cancelada para ${email}`);
          suscripcionesCanceladas.push(sub.id);
        }
      }

      if (suscripcionesCanceladas.length === 0) {
        console.warn(`⚠️ Stripe: ninguna suscripción activa/incompleta encontrada para ${email}`);
      }
    }
  } catch (errStripe) {
    console.error('❌ Error cancelando suscripción en Stripe:', errStripe.message);
  }

  // 🔻 Paso 2: Desactivar en Firestore
  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    await ref.set({
      activo: false,
      fechaBaja: new Date().toISOString()
    }, { merge: true });
    console.log(`🚫 Firestore: usuario marcado como inactivo (${email})`);
  } catch (errFS) {
    console.error('❌ Error actualizando Firestore:', errFS.message);
  }

  // 🔻 Paso 3: Desactivar en MemberPress
  try {
    const mpResp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: 10663
    });
    console.log(`🧩 MemberPress desactivado para ${email}`, mpResp);
    if (!mpResp.ok) {
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${mpResp?.error || 'Sin mensaje'}` };
    }
  } catch (errMP) {
    console.error('❌ Error al desactivar en MemberPress:', errMP.message || errMP);
    return { ok: false, mensaje: `Error al desactivar en MemberPress: ${errMP.message || errMP}` };
  }

  // 🔻 Paso 4: Enviar email de baja
  try {
    await enviarConfirmacionBajaClub(email, '');
    console.log(`📩 Email de baja enviado a ${email}`);
  } catch (errEmail) {
    console.error(`❌ Error al enviar email de baja:`, errEmail.message);
  }

  // 🔻 Paso 5: Eliminar usuario en WordPress (opcional)
  if (password) {
    try {
      const resp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
        email,
        password
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.LABOROTECA_API_KEY
        }
      });

      if (resp.data?.ok) {
        console.log(`🗑️ Usuario eliminado en WordPress: ${email}`);
      } else {
        console.warn('⚠️ Error eliminando usuario en WP:', resp.data);
      }
    } catch (errWP) {
      console.error('❌ Error conectando a WP para eliminar usuario:', errWP.message);
    }
  }

  return { ok: true, cancelada: true };
}

module.exports = desactivarMembresiaClub;
