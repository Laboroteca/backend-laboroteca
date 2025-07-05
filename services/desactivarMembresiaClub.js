const admin = require('../firebase');
const firestore = admin.firestore();

const { enviarConfirmacionBajaClub } = require('./email');
const { cancelarSuscripcionStripe } = require('./stripeUtils'); // <-- asegúrate de tener esta
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

    // Verificar contraseña usando bcrypt
    const bcrypt = require('bcryptjs');
    const esValida = await bcrypt.compare(password, hashAlmacenado);

    if (!esValida) {
      return { ok: false, mensaje: 'La contraseña no es correcta.' };
    }

    const nombre = datos?.nombre || '';

    // 🔴 1. Desactivar en Firestore
    await ref.set({
      activo: false,
      fechaBaja: new Date().toISOString()
    }, { merge: true });

    console.log(`🚫 [CLUB] Firestore actualizado para ${email}`);

    // 🔴 2. Cancelar en Stripe (debe devolver true si todo va bien)
    const resultadoStripe = await cancelarSuscripcionStripe(email);
    if (!resultadoStripe?.ok) {
      console.warn(`⚠️ Stripe no pudo cancelar suscripción de ${email}: ${resultadoStripe.mensaje}`);
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
