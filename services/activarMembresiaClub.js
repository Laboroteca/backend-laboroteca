// services/activarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();

/**
 * Activa la membresía del club para el email dado.
 * Marca como activo y actualiza la fecha de alta.
 * @param {string} email - Email del usuario
 * @returns {Promise<boolean>} true si se activó, false si no
 */
async function activarMembresiaClub(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    console.warn('Email inválido en activarMembresiaClub');
    return false; // no romper flujo
  }

  const ref = firestore.collection('usuariosClub').doc(email);

  try {
    await ref.set(
      {
        email,
        activo: true,
        fechaAlta: new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`✅ Membresía del Club activada para ${email}`);
    return true;
  } catch (err) {
    console.error(`❌ Error al activar membresía para ${email}:`, err?.message || err);
    return false; // no romper flujo si Firestore falla
  }
}

module.exports = { activarMembresiaClub };
