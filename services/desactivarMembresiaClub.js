const admin = require('../firebase');
const firestore = admin.firestore();
const { enviarConfirmacionBajaClub } = require('./email'); // ✅ IMPORTANTE

/**
 * Desactiva la membresía del Club Laboroteca para el email indicado.
 * Marca el campo `activo` como false y establece la fecha de baja.
 * Si el usuario no existe, lo crea con estado inactivo.
 * @param {string} email - Email del usuario a dar de baja
 */
async function desactivarMembresiaClub(email) {
  if (!email) throw new Error('Email vacío en desactivarMembresiaClub');

  const ref = firestore.collection('usuariosClub').doc(email);

  // 🔍 Recuperar el nombre si ya existe
  let nombre = '';
  const doc = await ref.get();
  if (doc.exists && doc.data().nombre) {
    nombre = doc.data().nombre;
  }

  // 🔧 Desactivar la membresía
  await ref.set({
    email,
    activo: false,
    fechaBaja: new Date().toISOString()
  }, { merge: true });

  console.log(`🚫 [CLUB] Membresía desactivada para: ${email}`);

  // 📧 Enviar email de confirmación
  try {
    const resultado = await enviarConfirmacionBajaClub(email, nombre);

    // Analizar respuesta SMTP2GO
    if (
      resultado?.data?.succeeded === 1 &&
      resultado?.data?.failed === 0
    ) {
      console.log(`📩 Email de confirmación enviado correctamente a ${email}`);
    } else {
      console.warn(`⚠️ Email de baja enviado pero con advertencias para ${email}:`, resultado);
    }
  } catch (error) {
    console.error(`❌ Error al enviar email de confirmación de baja a ${email}:`, error.message || error);
    // Pero no lanzamos error para no bloquear el resto del flujo
  }
}

module.exports = { desactivarMembresiaClub };
