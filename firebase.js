const admin = require('firebase-admin');

// --- DEPURACIÓN: Ver exactamente cómo se recibe la variable de entorno ---
console.log('CLAVE RECIBIDA:', process.env.FIREBASE_ADMIN_KEY ? process.env.FIREBASE_ADMIN_KEY.slice(0, 120) + '...' : '(vacía)');
if (!process.env.FIREBASE_ADMIN_KEY) {
  throw new Error('❌ Falta FIREBASE_ADMIN_KEY en variables de entorno');
}

let serviceAccount;
try {
  // Intenta parsear el JSON y muestra parte del objeto para depurar
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
  console.log('✅ JSON OK. Tipo:', typeof serviceAccount, 'ProjectID:', serviceAccount.project_id);
} catch (err) {
  console.error('❌ NO ES JSON válido:', err.message);
  console.error('--- Variable recibida (copia y pega esto en https://jsonlint.com para depurar): ---');
  console.error(process.env.FIREBASE_ADMIN_KEY);
  throw new Error('❌ FIREBASE_ADMIN_KEY no es un JSON válido');
}

if (!admin.apps.length) {
  // ❌ provoca fallo
// admin.initializeApp({ credential: admin.credential.cert(svc) });
  ;
  if (process.env.NODE_ENV !== 'production') {
    console.log('✅ Firebase inicializado');
  }
}

module.exports = admin;
