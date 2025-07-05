const admin = require('firebase-admin');

if (!process.env.FIREBASE_ADMIN_KEY) {
  throw new Error('❌ Falta FIREBASE_ADMIN_KEY en variables de entorno');
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
} catch (err) {
  throw new Error('❌ FIREBASE_ADMIN_KEY no es un JSON válido');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('✅ Firebase inicializado');
  }
}

module.exports = admin;
