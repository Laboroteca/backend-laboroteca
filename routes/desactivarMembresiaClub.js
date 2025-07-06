const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const fetch = require('node-fetch'); // Necesario para la llamada a WordPress

/**
 * Verifica email+password en WP (si no existe en Firestore)
 */
async function verificarLoginWordPress(email, password) {
  try {
    const res = await fetch('https://www.laboroteca.es/wp-json/labo/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    return !!data.ok;
  } catch (e) {
    console.error('❌ Error conectando a WP para login:', e.message);
    return false;
  }
}

/**
 * Desactiva la membresía del Club Laboroteca para un usuario dado.
 * Verifica la contraseña (Firestore o WP) y, si es correcta, desactiva en Stripe, Firestore y MemberPress.
 * @param {string} email - Email del usuario
 * @param {string} password - Contraseña para verificar identidad
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function desactivarMembresiaClub(email, password) {
  if (!email || !password) {
    return { ok: false, mensaje: 'Faltan datos obligatorios.' };
  }

  try {
    const ref = firestore.collection('usuariosClub').doc(email);
    const doc = await ref.get();

    let esValida = false;
    let nombre = '';

    if (doc.exists) {
      // Caso Firestore (registro club)
      const datos = doc.data();
      const hashAlmacenado = datos?.passwordHash;

      if (!hashAlmacenado) {
        // -----> Si está en Firestore pero sin contraseña: intentar en WordPress
        esValida = await verificarLoginWordPress(email, password);
        if (!esValida) {
          return { ok: false, mensaje: 'No se ha configurado una contraseña.' };
        }
      } else {
        if (typeof password !== 'string' || password.length < 6) {
          return { ok: false, mensaje: 'La contraseña no es válida.' };
        }
        const bcrypt = require('bcryptjs');
        esValida = await bcrypt.compare(password, hashAlmacenado);
        if (!esValida) {
          return { ok: false, mensaje: 'La contraseña no es correcta.' };
        }
      }
      nombre = datos?.nombre || '';
    } else {
      // -----> Caso solo WordPress
      esValida = await verificarLoginWordPress(email, password);
      if (!esValida) {
        return { ok: false, mensaje: 'El usuario no existe o la contraseña es incorrecta.' };
      }
    }

    // 🔴 1. Cancelar suscripciones activas en Stripe
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length) {
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

    // 🔴 2. Desactivar en Firestore (si existe)
    if (doc.exists) {
      await ref.update({
        activo: false,
        fechaBaja: new Date().toISOString()
      });
      console.log(`🚫 [CLUB] Firestore actualizado para ${email}`);
    }

    // 🔴 3. Desactivar en MemberPress
    await syncMemberpressClub({ email, accion: 'desactivar' });

    // 🔴 4. Enviar email de confirmación
    try {
      const resultadoEmail = await enviarConfirmacionBajaClub(email, nombre);
      if (resultadoEmail?.data?.succeeded === 1) {
        console.log(`📩 Email de baja enviado a ${email}`);
      } else {
        console.warn(`⚠️ Email no confirmado para ${email}:`, resultadoEmail);
      }
    } catch (errEmail) {
      console.error(`❌ Error al enviar email de baja: ${errEmail.message}`);
    }

    return { ok: true };
  } catch (error) {
    console.error(`❌ Error al desactivar membresía de ${email}:`, error.message);
    return { ok: false, mensaje: 'Error interno del servidor.' };
  }
}

module.exports = desactivarMembresiaClub;
