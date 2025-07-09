// 📁 services/borrarDatosUsuarioFirestore.js
const admin = require('../firebase');
const firestore = admin.firestore();

/**
 * Elimina datos personales del usuario en Firestore.
 * No elimina facturas ni archivos contables.
 * @param {string} email - Email del usuario a borrar
 * @returns {Promise<void>}
 */
async function borrarDatosUsuarioFirestore(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en borrarDatosUsuarioFirestore');
  }

  try {
    const rutas = [
      `usuariosClub/${email}`,
      `procesados/${email}`
      // Añade aquí otras rutas si en el futuro usas más colecciones con datos personales
    ];

    for (const ruta of rutas) {
      const ref = firestore.doc(ruta);
      const doc = await ref.get();
      if (doc.exists) {
        await ref.delete();
        console.log(`🗑️ Firestore: eliminado ${ruta}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error al borrar datos de ${email} en Firestore:`, err.message || err);
  }
}

module.exports = { borrarDatosUsuarioFirestore };
