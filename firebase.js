// firebase.js (seguro, sin exponer claves)
'use strict';

const admin = require('firebase-admin');

function readServiceAccount() {
  // Acepta JSON plano o JSON en base64 (compat)
  const raw =
    process.env.FIREBASE_ADMIN_KEY ||
    (process.env.GCP_CREDENTIALS_BASE64
      ? Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
      : '');

  if (!raw) {
    throw new Error('Falta FIREBASE_ADMIN_KEY (o GCP_CREDENTIALS_BASE64) en variables de entorno');
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    // No imprimir el contenido; solo el motivo
    throw new Error(`FIREBASE_ADMIN_KEY no es JSON válido: ${err.message}`);
  }
}

if (!admin.apps.length) {
  const creds = readServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(creds) });

  // Log mínimo y seguro (solo si se pide)
  const lvl = String(process.env.PLANB_LOG_LEVEL || '').toLowerCase();
  if (lvl === 'debug') {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        area: 'firebase',
        msg: 'init ok',
        meta: { project_id: creds.project_id || '(desconocido)' }, // no es secreto
      })
    );
  }
}

module.exports = admin;

