// utils/consentLogs.js
// Guarda consentimientos (Política de Privacidad / Términos y Condiciones)
// y sube snapshot HTML a GCS. Soporta dos modos:
//  - per-version (actual): 1 fichero por versión
//  - per-accept: 1 fichero por aceptación (carpeta versión / <acceptId>.html)
// Añade en Firestore: privacyHash/termsHash + privacyBlobPath/termsBlobPath + *SnapshotOk

const admin = require('firebase-admin');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { alertAdmin } = require('./alertAdmin');

// ───────────────────────────── Config ─────────────────────────────
const SNAPSHOT_MODE = (process.env.CONSENT_SNAPSHOT_MODE || 'per-version').toLowerCase(); // 'per-version' | 'per-accept'

// ───────────────────────────── Firebase Admin ─────────────────────────────
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(svc) });
    } catch (e) {
      console.warn('⚠️ Firebase Admin init falló:', e?.message || e);
      try {
        alertAdmin({
          area: 'consent_firebase_init',
          email: '-',
          err: e,
          meta: { hasSvcVar: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON }
        });
      } catch (_) {}
    }
  }
}
function getDb() {
  try {
    return admin.firestore();
  } catch (e) {
    throw new Error('Firestore no inicializado (falta admin.initializeApp).');
  }
}
let db;
try {
  db = getDb();
} catch (e) {
  try {
    alertAdmin({
      area: 'consent_db_init',
      email: '-',
      err: e,
      meta: { appsLength: admin.apps.length }
    });
  } catch (_) {}
  throw e;
}

// ───────────────────────────── GCS (opcional) ─────────────────────────────
let Storage = null;
try { ({ Storage } = require('@google-cloud/storage')); } catch {}

const GCS_BUCKET =
  process.env.GOOGLE_CLOUD_BUCKET ||
  process.env.GCS_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  process.env.GCLOUD_STORAGE_BUCKET ||
  '';

console.log('[CONSENT] GCS_BUCKET =', GCS_BUCKET || '(vacío)');
console.log('[CONSENT] SNAPSHOT_MODE =', SNAPSHOT_MODE);

let storage = null;
if (Storage) {
  try {
    let creds = null;

    if (process.env.GCP_CREDENTIALS_BASE64) {
      const raw = Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8');
      creds = JSON.parse(raw);
      console.log('[CONSENT] usando credenciales de GCP_CREDENTIALS_BASE64');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      console.log('[CONSENT] usando credenciales de FIREBASE_SERVICE_ACCOUNT_JSON');
    } else {
      console.log('[CONSENT] usando ADC (GOOGLE_APPLICATION_CREDENTIALS o metadatos)');
    }

    storage = creds ? new Storage({ credentials: creds, projectId: creds.project_id }) : new Storage();
  } catch (e) {
    console.warn('[CONSENT] GCS creds parse/init error:', e?.message || e);
    try {
      storage = new Storage();
    } catch {
      storage = null;
    }
    try {
      alertAdmin({
        area: 'consent_gcs_init',
        email: '-',
        err: e,
        meta: { hasBucket: !!GCS_BUCKET, hasLib: !!Storage }
      });
    } catch (_) {}
  }
}

const BASE_PATH = 'consents';

// ───────────────────────────── Utils ─────────────────────────────
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

// ───────────────────────────── Snapshots ─────────────────────────────
async function ensureSnapshot({ type, version, url, htmlOverride, acceptId }) {
  if (!GCS_BUCKET || !Storage || !storage) {
    console.warn('[CONSENT] Modo degradado: bucket o @google-cloud/storage ausentes', {
      hasBucket: !!GCS_BUCKET, hasLib: !!Storage, hasClient: !!storage
    });
    try {
      await alertAdmin({
        area: 'consent_snapshot_degraded',
        email: '-',
        err: new Error('Snapshot en modo degradado'),
        meta: { type, version, url, hasBucket: !!GCS_BUCKET, hasLib: !!Storage, hasClient: !!storage },
        dedupeKey: `consent:degraded:${type}:${version}`
      });
    } catch (_) {}
    const basis = htmlOverride || url || `${type}:${version}`;
    return { hash: 'sha256:' + sha256Hex(basis), blobPath: '', snapshotOk: false };
  }

  const bucket = storage.bucket(GCS_BUCKET);
  const folder = (type === 'pp') ? 'politica-privacidad' : 'terminos-condiciones';

  let blobPath;
  if (SNAPSHOT_MODE === 'per-accept') {
    // Un fichero por aceptación dentro de la carpeta de versión
    const safeAccept = (acceptId && /^[a-zA-Z0-9_-]+$/.test(acceptId))
      ? acceptId
      : new Date().toISOString().replace(/[:.]/g, '-');
    blobPath = `${BASE_PATH}/${folder}/${version}/${safeAccept}.html`;
  } else {
    // Comportamiento anterior: 1 fichero por versión
    blobPath = `${BASE_PATH}/${folder}/${version}.html`;
  }

  const file = bucket.file(blobPath);

  try {
    console.log('[CONSENT] Intentando subir snapshot', { type, version, bucket: GCS_BUCKET, SNAPSHOT_MODE });

    let content = '';

    if (SNAPSHOT_MODE === 'per-version') {
      // Si ya existe, devolvemos su hash (no reescribimos)
      const [exists] = await file.exists();
      if (exists) {
        const [buf] = await file.download();
        content = buf.toString('utf8');
        return { hash: 'sha256:' + sha256Hex(content), blobPath, snapshotOk: true };
      }
    }

    // per-accept (siempre sube) o per-version (cuando no existía)
    content = htmlOverride || (url ? await fetchHtml(url) : '');
    if (!content) {
      return { hash: 'sha256:' + sha256Hex(`${type}:${version}:${url || ''}`), blobPath: '', snapshotOk: false };
    }

    await file.save(content, {
      resumable: false,
      contentType: 'text/html; charset=utf-8',
      metadata: { cacheControl: 'public, max-age=31536000' }
    });

    return { hash: 'sha256:' + sha256Hex(content), blobPath, snapshotOk: true };
  } catch (e) {
    console.warn(`⚠️ Snapshot ${type}/${version} fallo:`, e?.message || e);
    try {
      await alertAdmin({
        area: 'consent_snapshot_fail',
        email: '-',
        err: e,
        meta: { type, version, url, bucket: GCS_BUCKET, path: blobPath },
        dedupeKey: `consent:snapshotFail:${type}:${version}`
      });
    } catch (_) {}
    return { hash: 'sha256:' + sha256Hex(`${type}:${version}:${url || ''}`), blobPath: '', snapshotOk: false };
  }
}

// ───────────────────────────── Guardar consentimiento ─────────────────────────────
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

  // Creamos el docRef primero para usar su id como acceptId (único y estable)
  const docRef = db.collection('consentLogs').doc();
  const acceptId = docRef.id;

  // Snapshots (pasan acceptId cuando SNAPSHOT_MODE=per-accept, inofensivo en per-version)
  const pp  = await ensureSnapshot({
    type: 'pp',
    version: privacyVersion,
    url: privacyUrl,
    htmlOverride: privacyHtml,
    acceptId
  });
  const tos = await ensureSnapshot({
    type: 'tos',
    version: termsVersion,
    url: termsUrl,
    htmlOverride: termsHtml,
    acceptId
  });

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

  const idxRef = db.collection('consentLogs_idx').doc(fingerprint);

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

  // ✅ Validación de campos críticos antes del commit (no bloquea)
  if (!data.email || !data.privacyHash || !data.termsHash || !data.privacyVersion || !data.termsVersion) {
    try {
      await alertAdmin({
        area: 'consent_log_incomplete',
        email: data.email || '-',
        err: new Error('Campos críticos de consentimiento vacíos'),
        meta: {
          email: data.email,
          uid: data.userId,
          termsVersion: data.termsVersion,
          privacyVersion: data.privacyVersion,
          privacyHash: data.privacyHash,
          termsHash: data.termsHash,
          checkboxes: data.checkboxes,
          source: data.source,
          sessionId: data.sessionId,
          paymentIntentId: data.paymentIntentId
        }
      });
    } catch (_) { /* no-op */ }
  }

  try {
    await batch.commit();
  } catch (e) {
    try {
      await alertAdmin({
        area: 'consent_log_commit',
        email: emailLower || '-',
        err: e,
        meta: {
          uid,
          termsVersion,
          privacyVersion,
          source,
          sessionId,
          paymentIntentId,
          privacySnapshotOk: !!pp.snapshotOk,
          termsSnapshotOk: !!tos.snapshotOk
        },
        dedupeKey: `consent:commit:${fingerprint}`
      });
    } catch (_) {}
    throw e;
  }

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
