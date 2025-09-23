// firebase.js (seguro, con normalización y fallback a ADC)
'use strict';

const admin = require('firebase-admin');

function readServiceAccountOrNull() {
  // Permite varias formas de inyectar credenciales:
  // - FIREBASE_ADMIN_KEY: JSON plano
  // - GCP_CREDENTIALS_JSON: JSON plano (alias)
  // - GCP_CREDENTIALS_BASE64: JSON en base64
  const raw =
    process.env.FIREBASE_ADMIN_KEY ||
    process.env.GCP_CREDENTIALS_JSON ||
    (process.env.GCP_CREDENTIALS_BASE64
      ? Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
      : '');

  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);

    // Normaliza private_key si viene con "\n" escapados (muy común en .env/CI)
    if (
      obj.private_key &&
      typeof obj.private_key === 'string' &&
      obj.private_key.includes('\\n') &&
      !obj.private_key.includes('\n')
    ) {
      obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    }

    return obj;
  } catch (err) {
    // No imprimimos el JSON; solo el motivo
    throw new Error(`FIREBASE_ADMIN_KEY/GCP_CREDENTIALS_* no es JSON válido: ${err.message}`);
  }
}

if (!admin.apps.length) {
  const lvl = String(process.env.PLANB_LOG_LEVEL || '').toLowerCase();
  const sa = readServiceAccountOrNull();

  // Intenta determinar projectId de forma explícita si está disponible
  const projectIdFromEnv =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (sa && sa.project_id) ||
    undefined;

  try {
    if (sa) {
      // Camino clásico con service account JSON
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: projectIdFromEnv,
      });
      if (lvl === 'debug') {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            area: 'firebase',
            msg: 'init ok',
            mode: 'service_account',
            meta: { project_id: projectIdFromEnv || '(desconocido)' },
          })
        );
      }
    } else {
      // Fallback a Application Default Credentials (ADC)
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: projectIdFromEnv,
      });
      if (lvl === 'debug') {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            area: 'firebase',
            msg: 'init ok',
            mode: 'adc',
            meta: { project_id: projectIdFromEnv || '(desconocido)' },
          })
        );
      }
    }
  } catch (e) {
    // Mensaje claro sin exponer secretos
    const hint = sa
      ? 'Revisa que la private_key esté bien formateada y el JSON sea válido.'
      : 'No hay credenciales en env y ADC no está disponible. En GCP usa una Service Account adjunta o define FIREBASE_ADMIN_KEY.';
    throw new Error(`Firebase Admin init failed: ${e.message}. ${hint}`);
  }
}

module.exports = admin;
