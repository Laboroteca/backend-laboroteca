const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

module.exports = admin; // ← ahora exportamos el objeto completo
