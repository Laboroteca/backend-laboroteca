// utils/consentLogs.js
// Guarda consentimientos (PP/TOS) y, si hay bucket, sube snapshot HTML por versión.
// Añade en Firestore: privacyHash/termsHash + privacyBlobPath/termsBlobPath + *SnapshotOk

const admin = require('firebase-admin');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ───────────────────────────── Firebase Admin ─────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(svc) });
    } catch (e) {
      console.warn('⚠️ Firebase Admin init falló:', e?.message || e);
    }
  }
}
function getDb() {
  try {
    return admin.firestore();
  } catch {
    throw new Error('Firestore no inicializado (falta admin.initializeApp).');
  }
}
const db = getDb();

// ───────────────────────────── GCS (opcional) ─────────────────────────────
let Storage = null;
try { ({ Storage } = require('@google-cloud/storage')); } catch {}

const GCS_BUCKET =
  process.env.GOOGLE_CLOUD_BUCKET || // ← tu variable real
  process.env.GCS_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  process.env.GCLOUD_STORAGE_BUCKET ||
  '';

const BASE_PATH = 'consents'; // consents/pp/2025-08-15.html, consents/tos/2025-08-15.html

// ───────────────────────────── Utils ─────────────────────────────
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}
function getIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '');
  return fwd ? fwd.split(',')[0].trim() : (req?.ip || req?.connection?.remoteAddress || '');
}

/**
 * Descarga HTML con UA explícito. No sigue redirecciones.
 */
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

    const req = lib.get(
      urlStr,
      {
        headers: {
          'User-Agent': 'LaborotecaBot/1.0 (+https://www.laboroteca.es)',
          'Accept': 'text/html,application/xhtml+xml'
        }
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} al descargar ${urlStr}`));
        }
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs}ms en ${urlStr}`)));
  });
}

/**
 * Sube snapshot de TOS/PP al bucket si está configurado.
 * Devuelve hash, ruta y flag de snapshotOk.
 */
async function ensureSnapshot({ type, version, url, htmlOverride }) {
  if (!GCS_BUCKET || !Storage) {
    const basis = htmlOverride || url || `${type}:${version}`;
    return { hash: 'sha256:' + sha256Hex(basis), blobPath: '', snapshotOk: false };
  }

  let storage;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      storage = new Storage({ credentials: creds, projectId: creds.project_id });
    } else {
      storage = new Storage(); // ADC
    }
  } catch (e) {
    console.warn('⚠️ GCS init error:', e?.message || e);
    storage = new Storage();
  }

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
    console.warn(`⚠️ Snapshot ${type}/${version} fallo:`, e?.message || e);
    return { hash: 'sha256:' + sha256Hex(`${type}:${version}:${url || ''}`), blobPath: '', snapshotOk: false };
  }
}

/**
 * Guarda un consentimiento en Firestore.
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

  const ip = req ? getIp(req) : '';
  const userAgent = req ? (req.headers['user-agent'] || '') : '';
  const emailLower = (email || '').toLowerCase();

  const pp  = await ensureSnapshot({ type: 'pp',  version: privacyVersion, url: privacyUrl, htmlOverride: privacyHtml });
  const tos = await ensureSnapshot({ type: 'tos', version: termsVersion,   url: termsUrl,   htmlOverride: termsHtml });

  const data = {
    userId: uid || null,
    email: emailLower,
    acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
    termsUrl, privacyUrl, termsVersion, privacyVersion,

    privacyHash: pp.hash,
    privacyBlobPath: pp.blobPath,
    privacySnapshotOk: !!pp.snapshotOk,
    termsHash: tos.hash,
    termsBlobPath: tos.blobPath,
    termsSnapshotOk: !!tos.snapshotOk,

    ip,
    userAgent,
    source,
    sessionId,
    paymentIntentId,

    checkboxes: { terms: !!(checkboxes?.terms), privacy: !!(checkboxes?.privacy) },
    ...extras
  };

  const fingerprint = sha256Hex([
    data.email,
    uid,
    termsVersion,
    privacyVersion,
    source,
    sessionId,
    paymentIntentId
  ].join('|'));

  const docRef = db.collection('consentLogs').doc(); // histórico
  const idxRef = db.collection('consentLogs_idx').doc(fingerprint); // índice

  const batch = db.batch();
  batch.set(docRef, { ...data, idx: fingerprint });
  batch.set(idxRef, {
    lastAt: admin.firestore.FieldValue.serverTimestamp(),
    ref: docRef.id,
    idx: fingerprint,
    hash: fingerprint,
    email: data.email,
    userId: data.userId,
    termsVersion,
    privacyVersion,
    source,
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
