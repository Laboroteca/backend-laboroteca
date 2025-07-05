const admin = require('firebase-admin');

if (!admin.apps.length) {
  // 🔐 Convertir cadena escapada a JSON, corrigiendo saltos de línea
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_ADMIN_KEY.replace(/\\n/g, '\n')
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

module.exports = admin;
