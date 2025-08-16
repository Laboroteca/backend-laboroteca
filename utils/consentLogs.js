// utils/consentLogs.js
// Guarda consentimientos (PP/TOS) y, si hay GCS_BUCKET, sube snapshot HTML por versión.
// Campos añadidos en Firestore: privacyHash/termsHash + privacyBlobPath/termsBlobPath + *SnapshotOk

const admin = require('firebase-admin');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---- Firebase Admin ----
if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } catch (e) {
    console.warn('Aviso: Firebase Admin no estaba inicializado y no hay credenciales válidas en ENV.');
  }
}
const db = admin.firestore();

// ---- GCS (opcional) ----
let Storage = null;
try { ({ Storage } = require('@google-cloud/storage')); } catch {}
const GCS_BUCKET = process.env.GCS_BUCKET || '';
const BASE_PATH = 'consents'; // consents/pp/2025-08-15.html, consents/tos/2025-08-15.html

// ---- Utils ----
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}
function getIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '');
  return fwd ? fwd.split(',')[0].trim() : (req?.ip || req?.connection?.remoteAddress || '');
}
function fetchHtml(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!urlStr) return reject(new Error('URL vacía'));
    let lib = https;
    try {
      const u = new URL(urlStr);
      lib = u.protocol === 'http:' ? http : https;
    } catch {
      return reject(new Error(`URL inválida: ${urlStr}`));
    }
    const req = lib.get(urlStr, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} al descargar ${urlStr}`));
      }
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs}ms en ${urlStr}`)));
  });
}

async function ensureSnapshot({ type, version, url, htmlOverride }) {
  // Sin bucket o sin lib → modo degradado: solo hash; no sube
  if (!GCS_BUCKET || !Storage) {
    const basis = htmlOverride || url || `${type}:${version}`;
    return { hash: 'sha256:' + sha256Hex(basis), blobPath: '', snapshotOk: false };
  }

  const storage = new Storage(); // usa GOOGLE_APPLICATION_CREDENTIALS
  const bucket = storage.bucket(GCS_BUCKET);
  const folder = type === 'pp' ? 'pp' : 'tos';
  const blobPath = `${BASE_PATH}/${folder}/${version}.html`;
  const file = bucket.file(blobPath);

  try {
    const [exists] = await file.exists();
    let content = '';
    if (exists) {
      const [buf] = await file.download();
      content = buf.toString('utf8');
    } else {
      content = htmlOverride || (url ? await fetchHtml(url) : '');
      if (!content) {
        // no podemos subir; al menos devolvemos hash estable
        return { hash: 'sha256:' + sha256Hex(`${type}:${version}:${url || ''}`), blobPath: '', snapshotOk: false };
      }
      await file.save(content, {
        resumable: false,
        contentType: 'text/html; charset=utf-8',
        metadata: { cacheControl: 'public, max-age=31536000' }
      });
    }
    return { hash: 'sha256:' + sha256Hex(content), blobPath, snapshotOk: true };
  } catch (e) {
    console.warn(`Snapshot ${type}/${version} fallo:`, e?.message || e);
    return { hash: 'sha256:' + sha256Hex(`${type}:${version}:${url || ''}`), blobPath: '', snapshotOk: false };
  }
}

/**
 * Guarda un registro de aceptación de Términos/Privacidad.
 * opts: { uid, email, termsUrl, privacyUrl, termsVersion, privacyVersion,
 *         checkboxes, source, sessionId, paymentIntentId, req, extras,
 *         termsHtml?, privacyHtml? }
 */
async function logConsent(opts = {}) {
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
    extras = {},
    termsHtml,
    privacyHtml
  } = opts;

  // Sello y contexto
  const ip = req ? getIp(req) : '';
  const userAgent = req ? (req.headers['user-agent'] || '') : '';

  // Snapshot + hash (no bloquea si falla: devuelve degradado)
  const pp  = await ensureSnapshot({ type: 'pp',  version: privacyVersion, url: privacyUrl, htmlOverride: privacyHtml });
  const tos = await ensureSnapshot({ type: 'tos', version: termsVersion,   url: termsUrl,   htmlOverride: termsHtml });

  const data = {
    userId: uid || null,
    email: (email || '').toLowerCase(),
    acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    termsUrl, privacyUrl, termsVersion, privacyVersion,
    // hashes + paths + flags
    privacyHash: pp.hash,
    privacyBlobPath: pp.blobPath,
    privacySnapshotOk: !!pp.snapshotOk,
    termsHash: tos.hash,
    termsBlobPath: tos.blobPath,
    termsSnapshotOk: !!tos.snapshotOk,

    ip, userAgent, source, sessionId, paymentIntentId,
    checkboxes: { terms: !!(checkboxes?.terms), privacy: !!(checkboxes?.privacy) },
    ...extras
  };

  // Dedupe suave (evita duplicados inmediatos del mismo usuario y versión)
  const fingerprint = sha256Hex([data.email, uid, termsVersion, privacyVersion, source, sessionId, paymentIntentId].join('|'));
  const docRef = db.collection('consentLogs').doc();                 // histórico con id aleatorio
  const idxRef = db.collection('consentLogs_idx').doc(fingerprint);  // sobrescribe si llega repetido

  const batch = db.batch();
  batch.set(docRef, { ...data, idx: fingerprint });
  batch.set(idxRef, {
    lastAt: admin.firestore.FieldValue.serverTimestamp(),
    ref: docRef.id,
    idx: fingerprint,
    email: data.email,
    userId: data.userId,
    termsVersion, privacyVersion, source,
    sessionId: data.sessionId,
    paymentIntentId: data.paymentIntentId
  }, { merge: true });
  if (uid) {
    const userRef = db.collection('users').doc(uid).collection('consents').doc(docRef.id);
    batch.set(userRef, { ...data, idx: fingerprint });
  }
  await batch.commit();

  return {
    id: docRef.id,
    idx: fingerprint,
    privacyHash: pp.hash,
    termsHash: tos.hash,
    privacyBlobPath: pp.blobPath,
    termsBlobPath: tos.blobPath,
    snapshotOk: !!pp.snapshotOk && !!tos.snapshotOk
  };
}

module.exports = { logConsent };
