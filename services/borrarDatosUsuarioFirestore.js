// 📁 services/borrarDatosUsuarioFirestore.js
const admin = require('../firebase');
const firestore = admin.firestore();

/**
 * Elimina datos personales del usuario en Firestore y asegura
 * que no volverá a recibir emails (suppressionList).
 * No elimina facturas ni archivos contables.
 * @param {string} email - Email del usuario a borrar
 * @returns {Promise<void>}
 */
async function borrarDatosUsuarioFirestore(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !e.includes('@')) {
    throw new Error('❌ Email inválido en borrarDatosUsuarioFirestore');
  }

  try {
    // Docs a eliminar (añadimos marketingConsents)
    const rutas = [
      `usuariosClub/${e}`,
      `procesados/${e}`,
      `marketingConsents/${e}`
      // Añade aquí otras rutas si en el futuro usas más colecciones con datos personales
    ];

    for (const ruta of rutas) {
      try {
        const ref = firestore.doc(ruta);
        const doc = await ref.get();
        if (doc.exists) {
          await ref.delete();
          console.log(`🗑️ Firestore: eliminado ${ruta}`);
        }
      } catch (err) {
        console.warn(`⚠️ No se pudo eliminar ${ruta}:`, err?.message || err);
      }
    }

    // Asegurar supresión para newsletters (idempotente)
    try {
      await firestore.collection('suppressionList').doc(e).set({
        email: e,
        scope: 'newsletter',
        reason: 'account_deleted',
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: new Date().toISOString()
      }, { merge: true });
      console.log(`✅ suppressionList asegurada para ${e}`);
    } catch (err) {
      console.error(`❌ Error al asegurar suppressionList/${e}:`, err?.message || err);
    }

  } catch (err) {
    console.error(`❌ Error al borrar datos de ${e} en Firestore:`, err?.message || err);
  }
}

module.exports = { borrarDatosUsuarioFirestore };
