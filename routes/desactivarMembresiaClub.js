// 📁 routes/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const { enviarConfirmacionBajaClub } = require('../services/email');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

async function desactivarMembresiaClub(email, password) {
  // 🔐 Validación básica
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }

  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }

  email = email.trim().toLowerCase();

  // 🔐 Verificar credenciales directamente contra WordPress
  try {
    const resp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      email,
      password,
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const datos = resp.data;
    if (!datos?.ok) {
      const mensaje = datos?.mensaje?.toLowerCase().includes('contraseña')
        ? 'Contraseña incorrecta'
        : datos?.mensaje || 'Credenciales no válidas';
      throw new Error(mensaje);
    }
  } catch (err) {
    const msg = err?.response?.data?.mensaje || err.message || 'Error al verificar la contraseña';
    console.error('❌ Error autenticando usuario:', msg);
    return { ok: false, mensaje: msg };
  }

  // 🔻 Paso 1: Cancelar suscripciones activas en Stripe
  try {
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length === 0) {
      console.warn(`⚠️ Stripe: cliente no encontrado (${email})`);
    } else {
      const customerId = clientes.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
      });Y

      for (const sub of subs.data) {
        if (['active', 'trialing', 'incomplete', 'past_due'].includes(sub.status)) {
          await stripe.subscriptions.cancel(sub.id, {
            invoice_now: false,
            prorate: false,
          });
          console.log(`🛑 Stripe: cancelada ${sub.id} (${email})`);
        }
      }
    }
  } catch (errStripe) {
    console.error('❌ Stripe error:', errStripe.message);
  }

  // 🔻 Paso 2: Marcar como inactivo en Firestore
  try {
    await firestore.collection('usuariosClub').doc(email).set({
      activo: false,
      fechaBaja: new Date().toISOString(),
    }, { merge: true });

    console.log(`📉 Firestore: baja registrada para ${email}`);
  } catch (errFS) {
    console.error('❌ Error Firestore:', errFS.message);
  }

  // 🔻 Paso 3: Desactivar en MemberPress
  try {
    const resp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: 10663,
    });

    console.log(`🧩 MemberPress sync`, resp);

    if (!resp.ok) {
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${resp?.error || 'Sin mensaje'}` };
    }
  } catch (errMP) {
    console.error('❌ Error MemberPress:', errMP.message);
    return { ok: false, mensaje: 'Error al desactivar en MemberPress.' };
  }

  // 🔻 Paso 4: Enviar email de confirmación
  try {
    await enviarConfirmacionBajaClub(email, '');
    console.log(`📩 Email enviado a ${email}`);
  } catch (errEmail) {
    console.error(`❌ Error al enviar email:`, errEmail.message);
  }

  // 🔻 Paso 5: Eliminar usuario en WordPress
  try {
    const resp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
      email,
      password,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LABOROTECA_API_KEY,
      },
    });

    if (resp.data?.ok) {
      console.log(`🗑️ Usuario eliminado en WP: ${email}`);
    } else {
      console.warn('⚠️ Error eliminando en WP:', resp.data);
    }
  } catch (errWP) {
    console.error('❌ Error WordPress:', errWP.message);
  }

  return { ok: true, cancelada: true };
}

module.exports = desactivarMembresiaClub;
