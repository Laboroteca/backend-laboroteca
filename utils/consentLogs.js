// utils/consentLogs.js
// Registra consentimientos (Política de Privacidad / Términos) en Firestore
// y sube snapshot HTML "per-accept" a GCS con metadatos para trazabilidad.
// Guarda nombre y apellidos para búsquedas. Enlaza Firestore <-> GCS por blobPath único.
// Dispara alertas a admin ante errores relevantes.

'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { alertAdmin } = require('./alertAdmin');

// ───────────────────────────── Config ─────────────────────────────
const SNAPSHOT_MODE = (process.env.CONSENT_SNAPSHOT_MODE || 'per-accept').toLowerCase(); // 'per-accept' | 'per-version'
const BUCKET_NAME =
  (process.env.GCS_CONSENTS_BUCKET || process.env.GCS_BUCKET || process.env.GCLOUD_STORAGE_BUCKET || '').trim();

const PROJECT_TIMEZONE = process.env.PROJECT_TZ || 'Europe/Madrid'; // usado para formateo de fecha visible

// ───────────────────────────── Firebase Admin ─────────────────────────────
if (!admin.apps.length) {
  // La inicialización real se hace en tu módulo ../firebase, pero por seguridad:
  try {
    admin.initializeApp();
  } catch (_) { /* ignore */ }
}

const firestore = admin.firestore();

// ───────────────────────────── Helpers ─────────────────────────────
const safe = v => (v === undefined || v === null) ? '' : String(v);

const sha256Hex = (str) =>
  crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');

function nowISO() {
  return new Date().toISOString();
}

/**
 * Descarga HTML bruto de una URL (http/https)
 */
function fetchHtml(rawUrl) {
  return new Promise((resolve, reject) => {
    if (!rawUrl) return reject(new Error('URL vacía para snapshot'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) { return reject(e); }

    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(parsed, (res) => {
      const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
      if (!ok) {
        return reject(new Error(`HTTP ${res.statusCode} al descargar ${rawUrl}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Timeout al descargar snapshot HTML'));
    });
  });
}

/**
 * Devuelve bucket de GCS (o null si no hay nombre)
 */
function getBucket() {
  if (!BUCKET_NAME) return null;
  try {
    return admin.storage().bucket(BUCKET_NAME);
  } catch (e) {
    return null;
  }
}

/**
 * Sube un HTML a GCS con metadatos
 */
async function uploadHtmlToGCS({ path, htmlBuffer, metadata }) {
  const bucket = getBucket();
  if (!bucket) {
    throw new Error('No hay bucket configurado para consents (GCS_CONSENTS_BUCKET/GCS_BUCKET).');
  }
  const file = bucket.file(path);
  await file.save(htmlBuffer, {
    resumable: false,
    contentType: 'text/html; charset=utf-8',
    metadata: {
      metadata: {
        ...metadata,
      },
    },
    public: false,
    validation: 'md5',
  });
  return path;
}

/**
 * Genera HTML de snapshot con una cabecera mínima de auditoría
 */
function buildSnapshotHtml({ rawHtmlBuffer, title, acceptedAtISO, email, ip, userAgent, extra = {} }) {
  const raw = rawHtmlBuffer ? rawHtmlBuffer.toString('utf8') : '';
  const banner = `
<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snapshot: ${title || ''}</title>
</head><body>
<!-- Snapshot Laboroteca (solo evidencia) -->
<div style="border:1px solid #ddd;padding:12px;margin:12px 0;font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;background:#fafafa">
  <div><strong>Este es un snapshot de evidencia</strong> (no operativo).</div>
  <div>Acceptado: <code>${acceptedAtISO}</code></div>
  <div>Email: <code>${email || ''}</code> · IP: <code>${ip || ''}</code></div>
  <div>User-Agent: <code>${userAgent || ''}</code></div>
  <div>Extra: <code>${JSON.stringify(extra)}</code></div>
</div>
<hr>
`;
  // Insertamos el HTML original tal cual tras el banner
  // Cerramos body/html solo si el original no lo hiciera
  const suffix = raw.includes('</body>') ? '' : '</body>';
  const suffix2 = raw.includes('</html>') ? '' : '</html>';
  return Buffer.from(banner + raw + suffix + suffix2, 'utf8');
}

/**
 * Normaliza inputs básicos
 */
function normalizeInput(payload = {}) {
  const {
    // identidad
    email,
    nombre,
    apellidos,
    userId,

    // contexto formulario / producto
    formularioId,
    tipoProducto,
    nombreProducto,
    descripcionProducto,

    // técnicos
    sessionId,
    paymentIntentId,
    userAgent,
    ip,
    source,

    // consentimiento
    checkboxes = { privacy: true, terms: true },
    acceptedAt, // Date | ISO | timestamp | undefined

    // versiones de documentos
    privacyUrl,
    privacyVersion,
    termsUrl,
    termsVersion,

    // índice/hash externo opcional
    idx,
  } = payload;

  // Fecha aceptación
  let acceptedAtISO = nowISO();
  try {
    if (acceptedAt instanceof Date) acceptedAtISO = acceptedAt.toISOString();
    else if (typeof acceptedAt === 'string' && acceptedAt) acceptedAtISO = new Date(acceptedAt).toISOString();
    else if (typeof acceptedAt === 'number') acceptedAtISO = new Date(acceptedAt).toISOString();
  } catch (_) { /* use now */ }

  const doc = {
    email: safe(email).toLowerCase().trim(),
    nombre: safe(nombre).trim(),
    apellidos: safe(apellidos).trim(),
    userId: safe(userId),

    formularioId: safe(formularioId),
    tipoProducto: safe(tipoProducto),
    nombreProducto: safe(nombreProducto),
    descripcionProducto: safe(descripcionProducto),

    sessionId: safe(sessionId),
    paymentIntentId: safe(paymentIntentId),
    userAgent: safe(userAgent),
    ip: safe(ip),
    source: safe(source),

    checkboxes: {
      privacy: !!(checkboxes && (checkboxes.privacy !== false)),
      terms: !!(checkboxes && (checkboxes.terms !== false)),
    },

    acceptedAt: admin.firestore.Timestamp.fromDate(new Date(acceptedAtISO)),
    acceptedAtISO, // campo redundante útil para logs rápidos

    privacyUrl: safe(privacyUrl),
    privacyVersion: safe(privacyVersion),
    termsUrl: safe(termsUrl),
    termsVersion: safe(termsVersion),

    idx: safe(idx),

    // se completan tras subir snapshots:
    privacyBlobPath: '',
    privacyHash: '',
    privacySnapshotOk: false,

    termsBlobPath: '',
    termsHash: '',
    termsSnapshotOk: false,
  };

  // Hash de versión (contenido URL) a nivel de texto, como traías
  if (doc.privacyUrl) doc.privacyHash = `sha256:${sha256Hex(doc.privacyUrl)}`;
  if (doc.termsUrl) doc.termsHash = `sha256:${sha256Hex(doc.termsUrl)}`;

  return doc;
}

// ───────────────────────────── Core ─────────────────────────────

/**
 * Registra consentimiento y sube snapshots a GCS (per-accept por defecto)
 * @param {object} payload  Campos descritos en normalizeInput + urls y versiones
 * @returns {Promise<{docId: string, privacyBlobPath?: string, termsBlobPath?: string}>}
 */
async function registrarConsentimiento(payload) {
  const data = normalizeInput(payload);

  // 1) Crear doc inicial en Firestore (para obtener docId y usarlo en la ruta del HTML)
  const col = firestore.collection('consentLogs');
  const initialDocRef = col.doc(); // id aleatorio
  const consentDocId = initialDocRef.id;

  // Guardado inicial (sin blobPath aún)
  await initialDocRef.set({
    ...data,
    insertadoEn: nowISO(),
  }).catch(async (e) => {
    await alertAdmin(`❌ Error al crear doc de consentLogs (${data.email}): ${e.message}`);
    throw e;
  });

  // 2) Decidir fileId para snapshots por aceptación
  const fileId = data.idx || consentDocId; // preferimos tu idx si existe

  // 3) Si hay bucket, intentar snapshots
  let privacyBlobPath = '';
  let termsBlobPath = '';
  let privacySnapshotOk = false;
  let termsSnapshotOk = false;

  if (getBucket()) {
    // PRIVACY
    try {
      if (data.privacyUrl && data.privacyVersion) {
        const rawHtml = await fetchHtml(data.privacyUrl);
        const htmlBuf = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Política de Privacidad v${data.privacyVersion}`,
          acceptedAtISO: data.acceptedAtISO,
          email: data.email,
          ip: data.ip,
          userAgent: data.userAgent,
          extra: {
            docId: consentDocId,
            idx: data.idx,
            formularioId: data.formularioId,
            version: data.privacyVersion,
          },
        });

        // rutas: per-accept / per-version
        const path =
          (SNAPSHOT_MODE === 'per-version')
            ? `consents/politica-privacidad/${data.privacyVersion}.html`
            : `consents/politica-privacidad/${data.privacyVersion}/${fileId}.html`;

        await uploadHtmlToGCS({
          path,
          htmlBuffer: htmlBuf,
          metadata: {
            kind: 'privacy',
            email: data.email,
            consentDocId,
            idx: data.idx,
            ip: data.ip,
            formularioId: data.formularioId,
            version: data.privacyVersion,
            source: data.source,
            userId: data.userId,
          },
        });

        privacyBlobPath = path;
        privacySnapshotOk = true;
      }
    } catch (e) {
      await alertAdmin(`⚠️ Error subiendo snapshot PRIVACY a GCS (${data.email}): ${e.message}`);
    }

    // TERMS
    try {
      if (data.termsUrl && data.termsVersion) {
        const rawHtml = await fetchHtml(data.termsUrl);
        const htmlBuf = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Términos y Condiciones v${data.termsVersion}`,
          acceptedAtISO: data.acceptedAtISO,
          email: data.email,
          ip: data.ip,
          userAgent: data.userAgent,
          extra: {
            docId: consentDocId,
            idx: data.idx,
            formularioId: data.formularioId,
            version: data.termsVersion,
          },
        });

        const path =
          (SNAPSHOT_MODE === 'per-version')
            ? `consents/terminos-condiciones/${data.termsVersion}.html`
            : `consents/terminos-condiciones/${data.termsVersion}/${fileId}.html`;

        await uploadHtmlToGCS({
          path,
          htmlBuffer: htmlBuf,
          metadata: {
            kind: 'terms',
            email: data.email,
            consentDocId,
            idx: data.idx,
            ip: data.ip,
            formularioId: data.formularioId,
            version: data.termsVersion,
            source: data.source,
            userId: data.userId,
          },
        });

        termsBlobPath = path;
        termsSnapshotOk = true;
      }
    } catch (e) {
      await alertAdmin(`⚠️ Error subiendo snapshot TERMS a GCS (${data.email}): ${e.message}`);
    }
  } else {
    // No hay bucket -> avisamos una sola vez por aceptación
    await alertAdmin(`ℹ️ Consentimiento sin snapshot (sin bucket): ${data.email} · docId=${consentDocId}`);
  }

  // 4) Actualizar doc con blob paths + flags (y asegurar nombre/apellidos)
  const updatePayload = {
    privacyBlobPath: privacyBlobPath || data.privacyBlobPath || '',
    privacySnapshotOk: privacySnapshotOk,
    termsBlobPath: termsBlobPath || data.termsBlobPath || '',
    termsSnapshotOk: termsSnapshotOk,

    // garantizamos que se guardan nombre y apellidos (para tus búsquedas)
    nombre: data.nombre,
    apellidos: data.apellidos,
  };

  await initialDocRef.update(updatePayload).catch(async (e) => {
    await alertAdmin(`❌ Error actualizando consentLogs (blobPaths) ${consentDocId}: ${e.message}`);
    throw e;
  });

  // 5) Índice secundario opcional (para búsquedas rápidas)
  try {
    const idxCol = firestore.collection('consentLogs_idx');
    await idxCol.doc(consentDocId).set({
      email: data.email,
      nombreCompleto: `${data.nombre} ${data.apellidos}`.trim(),
      acceptedAt: admin.firestore.Timestamp.fromDate(new Date(data.acceptedAtISO)),
      consentId: consentDocId,
      formularioId: data.formularioId,
      idx: data.idx || '',
      privacyVersion: data.privacyVersion,
      termsVersion: data.termsVersion,
      createdAt: nowISO(),
    }, { merge: false });
  } catch (e) {
    await alertAdmin(`⚠️ Error creando índice consentLogs_idx para ${consentDocId}: ${e.message}`);
    // no interrumpimos el flujo principal
  }

  // 6) Señal final si faltó algún snapshot cuando debía
  if ((data.privacyUrl && !privacySnapshotOk) || (data.termsUrl && !termsSnapshotOk)) {
    await alertAdmin(`⚠️ Consent regist. con snapshots incompletos: email=${data.email}, docId=${consentDocId}, privacyOk=${privacySnapshotOk}, termsOk=${termsSnapshotOk}`);
  }

  return {
    docId: consentDocId,
    privacyBlobPath,
    termsBlobPath,
  };
}

// ───────────────────────────── Exports ─────────────────────────────
module.exports = {
  registrarConsentimiento,
};
