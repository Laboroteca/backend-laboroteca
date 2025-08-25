// services/activarMembresiaClub.js
const admin = require('../firebase');
const firestore = admin.firestore();
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

/**
 * Activa la membresía del club para el email dado.
 * Marca como activo y actualiza la fecha de alta.
 * @param {string} email - Email del usuario
 * @returns {Promise<boolean>} true si se activó, false si no
 */
async function activarMembresiaClub(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    console.warn('Email inválido en activarMembresiaClub');
    await alertAdmin({
      area: 'activarMembresiaClub_email_invalido',
      email: email || '(no definido)',
      err: new Error('Email inválido'),
      meta: { email }
    });
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
    await alertAdmin({
      area: 'activarMembresiaClub_firestore_error',
      email,
      err,
      meta: { email }
    });
    return false; // no romper flujo si Firestore falla
  }
}

module.exports = { activarMembresiaClub };
