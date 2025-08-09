const { activarMembresiaEnMemberPress } = require('../../services/memberpress');

/**
 * Activa la membresía adecuada según el libro canjeado.
 * 
 * @param {string} email - Email del usuario que ha canjeado el código
 * @param {string} libro - Valor exacto del campo libro_elegido
 */
module.exports = async function activarMembresiaPorRegalo(email, libro) {
  const emailNormalizado = email.trim().toLowerCase();
  const titulo = (libro || '').trim().toLowerCase();

  let membershipId = null;

  if (titulo.includes('de cara a la jubilación')) {
    membershipId = 7994; // Libro: De cara a la Jubilación
  } else if (
    titulo.includes('adelanta tu jubilación') ||
    titulo.includes('jubilación anticipada') ||
    titulo.includes('jubilación parcial')
  ) {
    membershipId = 11006; // Libro: Jubilación anticipada y parcial
  } else {
    throw new Error('❌ No se reconoce el libro seleccionado');
  }

  await activarMembresia(emailNormalizado, membershipId);

  console.log(`🎁 Membresía ${membershipId} activada por regalo para ${emailNormalizado}`);
};
