const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');

/**
 * Verifica email+password en WordPress
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function verificarLoginWordPress(email, password) {
  try {
    const res = await fetch('https://www.laboroteca.es/wp-json/labo/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!data || typeof data.ok === 'undefined') {
      return { ok: false, mensaje: 'Respuesta inesperada del servidor de WordPress.' };
    }

    return data;
  } catch (e) {
    console.error('❌ Error conectando a WP para login:', e.message);
    return { ok: false, mensaje: 'No se pudo conectar con WordPress.' };
  }
}

/**
 * Desactiva la membresía del Club Laboroteca para un usuario dado.
 * Verifica la contraseña (Firestore o WP) y, si es correcta, desactiva en Stripe, Firestore y MemberPress.
 * @param {string} email
 * @param {string} password
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
      const datos = doc.data();
      const hashAlmacenado = datos?.passwordHash;

      if (!hashAlmacenado) {
        // Sin hash: verificar contra WordPress
        const wpLogin = await verificarLoginWordPress(email, password);
        if (!wpLogin.ok) {
          return { ok: false, mensaje: wpLogin.mensaje || 'No se ha podido verificar la contraseña.' };
        }
        esValida = true;
      } else {
        // Verificar con bcrypt
        if (typeof password !== 'string' || password.length < 6) {
          return { ok: false, mensaje: 'La contraseña no es válida.' };
        }

        esValida = await bcrypt.compare(password, hashAlmacenado);
        if (!esValida) {
          return { ok: false, mensaje: 'La contraseña introducida no es correcta.' };
        }
      }

      nombre = datos?.nombre || '';
    } else {
      // No existe en Firestore → verificar con WordPress
      const wpLogin = await verificarLoginWordPress(email, password);
      if (!wpLogin.ok) {
        return { ok: false, mensaje: wpLogin.mensaje || 'El usuario no existe o la contraseña no es válida.' };
      }
      esValida = true;
    }

    if (!esValida) {
      return { ok: false, mensaje: 'No se ha podido verificar la contraseña.' };
    }

    // 🔴 1. Cancelar suscripciones en Stripe
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

    // 🔴 2. Desactivar en Firestore
    if (doc.exists) {
      await ref.update({
        activo: false,
        fechaBaja: new Date().toISOString()
      });
      console.log(`🚫 [CLUB] Firestore actualizado para ${email}`);
    }

    // 🔴 3. Desactivar en MemberPress
    await syncMemberpressClub({ email, accion: 'desactivar' });

    // 🔴 4. Email de confirmación
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
