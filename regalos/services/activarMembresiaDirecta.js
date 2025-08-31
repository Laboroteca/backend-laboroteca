// 📂 regalos/services/activarMembresiaDirecta.js

const { activarMembresia } = require('./memberpress');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

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

  try {
    // 🚀 Activar en MemberPress
    await activarMembresia(emailNormalizado, membershipId);
    console.log(`🎯 Membresía ${membershipId} activada directamente para ${emailNormalizado}`);
  } catch (err) {
    console.error(`❌ Error al activar la membresía ${membershipId} para ${emailNormalizado}:`, err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.activarMembresiaDirecta.error',
        email: emailNormalizado,
        err,
        meta: { membershipId }
      });
    } catch (_) {}
    throw err;
  }
};
