const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

/**
 * Verifica email+password en WordPress (único método, siempre WP)
 */
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

/**
 * Desactiva la membresía del Club Laboroteca y elimina el usuario de WordPress.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function desactivarMembresiaClub(email, password) {
  if (!email || !password) {
    return { ok: false, mensaje: 'Faltan datos obligatorios.' };
  }

  // 1. Verificar en WordPress
  const wpLogin = await verificarLoginWordPress(email, password);
  if (!wpLogin.ok) {
    return { ok: false, mensaje: wpLogin.mensaje || 'Contraseña incorrecta' };
  }

  // 2. Cancelar suscripciones activas en Stripe
  try {
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length > 0) {
      const customerId = clientes.data[0].id;
      const subsActivas = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 10
      });
      for (const sub of subsActivas.data) {
        await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
        console.log(`🛑 Stripe: suscripción ${sub.id} cancelada para ${email}`);
      }
    } else {
      console.warn(`⚠️ Stripe: cliente no encontrado para ${email}`);
    }
  } catch (errStripe) {
    console.error(`❌ Error cancelando suscripción en Stripe:`, errStripe.message);
  }

  // 3. Marcar como inactivo en Firestore (si existe)
  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    const doc = await ref.get();
    if (doc.exists) {
      await ref.set({
        activo: false,
        fechaBaja: new Date().toISOString()
      }, { merge: true });
      console.log(`🚫 [CLUB] Firestore actualizado para ${email}`);
    }
  } catch (errFS) {
    console.error(`❌ Error actualizando Firestore:`, errFS.message);
  }

  // 4. Desactivar en MemberPress
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
    console.error(`❌ Error al desactivar en MemberPress:`, errMP.message || errMP);
    return { ok: false, mensaje: `Error al desactivar en MemberPress: ${errMP.message || errMP}` };
  }

  // 5. Email de confirmación
  try {
    await enviarConfirmacionBajaClub(email, "");
    console.log(`📩 Email de baja enviado a ${email}`);
  } catch (errEmail) {
    console.error(`❌ Error al enviar email de baja: ${errEmail.message}`);
  }

  // 6. Eliminar cuenta en WordPress
  try {
    const resp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
      email
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LABOROTECA_API_KEY
      }
    });

    if (resp.data?.ok) {
      console.log(`🗑️ Usuario eliminado en WordPress: ${email}`);
    } else {
      console.warn(`⚠️ Error eliminando usuario en WP:`, resp.data);
    }
  } catch (errWP) {
    console.error(`❌ Error conectando a WP para eliminar usuario:`, errWP.message);
  }

  return { ok: true };
}

module.exports = desactivarMembresiaClub;
