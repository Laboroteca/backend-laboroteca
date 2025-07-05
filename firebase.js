// firebase.js

const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase inicializado correctamente');
  } catch (error) {
    console.error('❌ Error al inicializar Firebase:', error);
  }
}

module.exports = admin;
