const admin = require('../firebase');
const firestore = admin.firestore();
const { enviarConfirmacionBajaClub } = require('./email');

/**
 * Desactiva la membresía del Club Laboroteca para el email indicado.
 * Marca el campo `activo` como false y guarda la fecha de baja.
 * Si el usuario no existe, lo crea como inactivo.
 * @param {string} email - Email del usuario a dar de baja
 */
async function desactivarMembresiaClub(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en desactivarMembresiaClub');
  }

  const ref = firestore.collection('usuariosClub').doc(email);
  let nombre = '';

  try {
    const doc = await ref.get();
    if (doc.exists) {
      nombre = doc.data()?.nombre || '';
    }
  } catch (err) {
    console.warn(`⚠️ No se pudo recuperar el documento de ${email}: ${err.message}`);
  }

  await ref.set({
    email,
    activo: false,
    fechaBaja: new Date().toISOString()
  }, { merge: true });

  console.log(`🚫 [CLUB] Membresía desactivada para: ${email}`);

  try {
    const resultado = await enviarConfirmacionBajaClub(email, nombre);

    if (resultado?.data?.succeeded === 1 && resultado?.data?.failed === 0) {
      console.log(`📩 Email de confirmación enviado correctamente a ${email}`);
    } else {
      console.warn(`⚠️ Email enviado con advertencias a ${email}:`, resultado);
    }
  } catch (error) {
    console.error(`❌ Error al enviar email de baja a ${email}:`, error.message || error);
  }
}

module.exports = { desactivarMembresiaClub };
