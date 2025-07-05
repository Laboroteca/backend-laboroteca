const admin = require('firebase-admin');

if (!process.env.FIREBASE_ADMIN_KEY) {
  throw new Error('❌ Falta FIREBASE_ADMIN_KEY en variables de entorno');
}

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

module.exports = admin;
