// 📂 regalos/services/activarMembresiaDirecta.js

const { activarMembresia } = require('./memberpress');

/**
 * Activa directamente una membresía en MemberPress para un usuario dado.
 * No realiza cobro; útil para canjes de códigos regalo o entradas.
 *
 * @param {string} email - Email del usuario al que se le activa la membresía.
 * @param {number} membershipId - ID de la membresía en MemberPress.
 * @throws {Error} Si faltan datos o la activación falla.
 */
module.exports = async function activarMembresiaDirecta(email, membershipId) {
  const emailNormalizado = String(email || '').trim().toLowerCase();

  if (!emailNormalizado || !membershipId) {
    throw new Error('Faltan datos para activar la membresía.');
  }

  // 🚀 Activar en MemberPress
  await activarMembresia(emailNormalizado, membershipId);

  console.log(`🎯 Membresía ${membershipId} activada directamente para ${emailNormalizado}`);
};
