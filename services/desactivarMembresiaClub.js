const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

/**
 * Desactiva la membresía del Club Laboroteca para un usuario dado.
 * Verifica la contraseña real en WordPress y, si es correcta, desactiva en Stripe, Firestore, MemberPress y borra cuenta WP.
 * @param {string} email - Email del usuario
 * @param {string} password - Contraseña para verificar identidad
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function desactivarMembresiaClub(email, password) {
  console.log(`[BajaClub] Iniciando baja para: ${email}`);

  if (!email || !password) {
    console.log('[BajaClub] Faltan datos obligatorios');
    return { ok: false, mensaje: 'Faltan datos obligatorios.' };
  }

  try {
    // 🔐 1. Verificar login contra WordPress
    console.log('[BajaClub] Verificando login en WordPress...');
    const wpResp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      email,
      password
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (!wpResp.data?.ok) {
      let msg = wpResp.data?.mensaje || '';
      if (msg.toLowerCase().includes('contraseña') || msg.toLowerCase().includes('password')) {
        msg = 'Contraseña incorrecta';
      }
      console.log(`[BajaClub] Login incorrecto: ${msg}`);
      return { ok: false, mensaje: msg || 'Contraseña incorrecta' };
    }

    // 🔍 2. Buscar en Firestore
    const ref = firestore.collection('usuariosClub').doc(email);
    const doc = await ref.get();

    if (!doc.exists) {
      console.log('[BajaClub] Usuario no existe en Firestore');
      return { ok: false, mensaje: 'El usuario no existe en la base de datos.' };
    }

    const datos = doc.data();
    const nombre = datos?.nombre || '';

    // 🔴 3. Cancelar suscripciones activas en Stripe
    try {
      const clientes = await stripe.customers.list({ email, limit: 1 });
      if (clientes.data.length === 0) {
        console.warn(`⚠️ Stripe: cliente no encontrado para ${email}`);
      } else {
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
      }
    } catch (errStripe) {
      console.error(`❌ Error cancelando suscripción en Stripe:`, errStripe.message);
    }

    // 🔴 4. Marcar como inactivo en Firestore
    try {
      await ref.set({
        activo: false,
        fechaBaja: new Date().toISOString()
      }, { merge: true });

      console.log(`📉 Firestore: usuario marcado como inactivo → ${email}`);
    } catch (errFS) {
      console.error(`❌ Error actualizando Firestore:`, errFS.message);
    }

    // 🔴 5. Desactivar en MemberPress
    try {
      const mpResp = await syncMemberpressClub({
        email,
        accion: 'desactivar',
        membership_id: 10663 // ID del Club Laboroteca
      });
      console.log(`🧩 MemberPress desactivado para ${email}`, mpResp);
      if (!mpResp.ok) {
        return { ok: false, mensaje: `Error desactivando en MemberPress: ${mpResp?.error || 'Sin mensaje'}` };
      }
    } catch (errMP) {
      console.error(`❌ Error al desactivar en MemberPress:`, errMP.message || errMP);
      return { ok: false, mensaje: `Error al desactivar en MemberPress: ${errMP.message || errMP}` };
    }

    // 🔴 6. Email de confirmación
    try {
      const resultadoEmail = await enviarConfirmacionBajaClub(email, nombre);
      if (resultadoEmail?.data?.succeeded === 1) {
        console.log(`📩 Email de baja enviado a ${email}`);
      } else {
        console.warn(`⚠️ Email no confirmado para ${email}:`, resultadoEmail);
      }
    } catch (errEmail) {
      console.error(`❌ Error al enviar email de baja:`, errEmail.message);
    }

    // 🔴 7. Eliminar cuenta en WordPress (final)
    try {
      const eliminarResp = await axios.post('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
        email
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.LABOROTECA_API_KEY
        }
      });

      if (eliminarResp.data?.ok) {
        console.log(`🗑️ Usuario eliminado en WordPress: ${email}`);
      } else {
        console.warn(`⚠️ Error eliminando usuario en WP:`, eliminarResp.data);
      }
    } catch (errWP) {
      console.error(`❌ Error conectando a WP para eliminar usuario:`, errWP.message);
    }

    return { ok: true };

  } catch (error) {
    // Error externo (como 401 desde WP login)
    if (error.response && error.response.data && typeof error.response.data.mensaje !== 'undefined') {
      let msg = error.response.data.mensaje || '';
      if (msg.toLowerCase().includes('contraseña') || msg.toLowerCase().includes('password')) {
        msg = 'Contraseña incorrecta';
      }
      console.log(`[BajaClub] Error login WP: ${msg}`);
      return { ok: false, mensaje: msg || 'Contraseña incorrecta' };
    }

    console.error(`❌ Error global al desactivar membresía de ${email}:`, error.message || error);
    return { ok: false, mensaje: 'Error interno del servidor.' };
  }
}

module.exports = desactivarMembresiaClub;
