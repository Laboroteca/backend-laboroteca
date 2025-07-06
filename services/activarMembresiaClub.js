// services/activarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();

/**
 * Activa la membresía del club para el email dado.
 * Marca como activo y actualiza la fecha de alta.
 * @param {string} email - Email del usuario
 * @returns {Promise<void>}
 */
async function activarMembresiaClub(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Email inválido en activarMembresiaClub');
  }

  const ref = firestore.collection('usuariosClub').doc(email);

  try {
    await ref.set({
      email,
      activo: true,
      fechaAlta: new Date().toISOString()
    }, { merge: true });

    console.log(`✅ Membresía del Club activada para ${email}`);
  } catch (err) {
    console.error(`❌ Error al activar membresía para ${email}:`, err.message || err);
    throw err;
  }
}

module.exports = { activarMembresiaClub };
