// 📁 routes/desactivarMembresiaClub.js
// Este archivo gestiona la baja manual del Club desde formularios web.
// Verifica credenciales, cancela Stripe, desactiva en Firestore y MemberPress.

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('../services/email');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

async function desactivarMembresiaClub(email, password) {
  // 🔐 Validación inicial
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }

  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }

  email = email.trim().toLowerCase();

  // 🔐 Verificar credenciales en WordPress
  try {
    const respuesta = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const datos = await respuesta.json();

    if (!datos?.ok) {
      let mensaje = datos.mensaje || '';
      if (mensaje.toLowerCase().includes('contraseña')) {
        mensaje = 'Contraseña incorrecta';
      }
      return { ok: false, mensaje: mensaje || 'Contraseña incorrecta' };
    }
  } catch (err) {
    console.error('❌ Error conectando a WordPress para verificar login:', err.message);
    return { ok: false, mensaje: 'No se pudo verificar la contraseña.' };
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

  return { ok: true, cancelada: true };
}

module.exports = desactivarMembresiaClub;
