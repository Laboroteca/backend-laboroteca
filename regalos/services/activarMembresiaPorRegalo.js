// 📂 regalos/services/activarMembresiaPorRegalo.js

const { activarMembresia } = require('./memberpress');

/**
 * Activa la membresía adecuada según el libro canjeado.
 * @param {string} email - Email del usuario que ha canjeado el código
 * @param {string} libro - Valor exacto del campo libro_elegido
 */
module.exports = async function activarMembresiaPorRegalo(email, libro) {
  // 🧹 Normalización de datos
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const titulo = String(libro || '').trim().toLowerCase();

  if (!emailNormalizado || !titulo) {
    throw new Error('Faltan datos para activar la membresía.');
  }

  let membershipId = null;

  // 📚 Asignar ID según el libro
  if (titulo.includes('de cara a la jubilación')) {
    membershipId = 7994; // Libro: De cara a la Jubilación
  } else if (titulo.includes('adelanta tu jubilación')) {
    membershipId = 12009; // Libro: Adelanta tu Jubilación (nuevo ID)
  } else if (
    titulo.includes('jubilación anticipada') ||
    titulo.includes('jubilación parcial')
  ) {
    membershipId = 11006; // Libro: Jubilación anticipada y parcial
  } else {
    throw new Error('No se reconoce el libro seleccionado.');
  }

  // 🚀 Activar en MemberPress
  await activarMembresia(emailNormalizado, membershipId);

  console.log(`🎁 Membresía ${membershipId} activada por regalo para ${emailNormalizado}`);
};
