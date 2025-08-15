// utils/consentLogs.js
const admin = require('firebase-admin');
const crypto = require('crypto');

// Usará la instancia ya inicializada en tu backend. Si no hubiera, intenta iniciar con ENV opcional.
if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) {
    console.warn('Aviso: Firebase Admin no estaba inicializado y no hay credenciales válidas en ENV.');
  }
}

function getIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  return fwd ? fwd.split(',')[0].trim() : (req.ip || req.connection?.remoteAddress || '');
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

/**
 * Guarda un registro de aceptación de Términos/Privacidad.
 * opts: { uid, email, termsUrl, privacyUrl, termsVersion, privacyVersion,
 *         checkboxes, source, sessionId, paymentIntentId, req, extras }
 */
async function logConsent(opts = {}) {
  const db = admin.firestore();
  const {
    uid = null,
    email = '',
    termsUrl = '',
    privacyUrl = '',
    termsVersion = '',
    privacyVersion = '',
    checkboxes = { terms: true, privacy: true },
    source = '',
    sessionId = '',
    paymentIntentId = '',
    req = null,
    extras = {}
  } = opts;

  const ip = req ? getIp(req) : '';
  const userAgent = req ? (req.headers['user-agent'] || '') : '';

  const data = {
    userId: uid || null,
    email: (email || '').toLowerCase(),
    acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    termsUrl, privacyUrl, termsVersion, privacyVersion,
    ip, userAgent, source, sessionId, paymentIntentId,
    checkboxes: { terms: !!(checkboxes?.terms), privacy: !!(checkboxes?.privacy) },
    ...extras
  };

  // Dedupe suave (evita duplicados inmediatos del mismo usuario y versión)
  const fingerprint = sha256([data.email, uid, termsVersion, privacyVersion, source, sessionId, paymentIntentId].join('|'));
  const docRef = db.collection('consentLogs').doc(); // histórico con id aleatorio
  const idxRef = db.collection('consentLogs_idx').doc(fingerprint); // sobrescribe si llega repetido

  const batch = db.batch();
  batch.set(docRef, { ...data, idx: fingerprint });
  batch.set(idxRef, { lastAt: admin.firestore.FieldValue.serverTimestamp(), ref: docRef.id, ...data });
  if (uid) {
    const userRef = db.collection('users').doc(uid).collection('consents').doc(docRef.id);
    batch.set(userRef, { ...data, idx: fingerprint });
  }
  await batch.commit();

  return { id: docRef.id, idx: fingerprint };
}

module.exports = { logConsent };
