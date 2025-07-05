const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { enviarConfirmacionBajaClub } = require('./email');
const { syncMemberpressClub } = require('./syncMemberpressClub');

/**
 * Desactiva la membresía del Club Laboroteca para un usuario dado.
 * Verifica la contraseña y, si es correcta, desactiva en Stripe, Firestore y MemberPress.
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

    if (!doc.exists) {
      return { ok: false, mensaje: 'El usuario no existe en la base de datos.' };
    }

    const datos = doc.data();
    const hashAlmacenado = datos?.passwordHash;

    if (!hashAlmacenado) {
      return { ok: false, mensaje: 'No se ha configurado una contraseña.' };
    }

    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, mensaje: 'La contraseña no es válida.' };
    }

    const bcrypt = require('bcryptjs');
    const esValida = await bcrypt.compare(password, hashAlmacenado);

    if (!esValida) {
      return { ok: false, mensaje: 'La contraseña no es correcta.' };
    }

    const nombre = datos?.nombre || '';

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

    // 🔴 2. Desactivar en Firestore
    await ref.update({
      activo: false,
      fechaBaja: new Date().toISOString()
    });

    console.log(`🚫 [CLUB] Firestore actualizado para ${email}`);

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
