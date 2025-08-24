// utils/consentLogs.js
// Registra consentimientos (Privacidad / Términos) en Firestore
// y sube snapshots HTML a GCS: uno GENERAL por versión + uno INDIVIDUAL por aceptación.
// Maneja registro (solo Privacidad) vs compras (Privacidad + Términos).

'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const { alertAdmin } = require('./alertAdmin');

// ───────────────────────────── Config ─────────────────────────────
const BUCKET_NAME =
  (process.env.GCS_CONSENTS_BUCKET ||
   process.env.GCS_BUCKET ||
   process.env.GCLOUD_STORAGE_BUCKET ||
   '').trim();

const PROJECT_TIMEZONE = process.env.PROJECT_TZ || 'Europe/Madrid'; // reservado (formateos futuros)

// ───────────────────────────── Firebase Admin ─────────────────────────────
if (!admin.apps.length) {
  try { admin.initializeApp(); } catch (_) { /* noop */ }
}
const firestore = admin.firestore();

// ───────────────────────────── Helpers ─────────────────────────────
const safe = v => (v === undefined || v === null) ? '' : String(v);

const sha256Hex = (str) =>
  crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');

const nowISO = () => new Date().toISOString();

function getBucket() {
  if (!BUCKET_NAME) return null;
  try { return admin.storage().bucket(BUCKET_NAME); }
  catch { return null; }
}

/**
 * Descarga HTML de una URL con soporte de redirecciones.
 * Sigue hasta 5 redirecciones para evitar 301/302.
 */
function fetchHtml(rawUrl, hops = 0) {
  return new Promise((resolve, reject) => {
    if (!rawUrl) return reject(new Error('URL vacía para snapshot'));
    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) { return reject(e); }

    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'User-Agent': 'LaborotecaSnapshot/1.0 (+https://www.laboroteca.es)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 15000
    }, (res) => {
      const code = res.statusCode || 0;

      // Redirecciones
      if ([301,302,303,307,308].includes(code) && res.headers.location) {
        if (hops >= 5) {
          return reject(new Error(`Demasiadas redirecciones al descargar ${rawUrl}`));
        }
        const next = new URL(res.headers.location, rawUrl).toString();
        res.resume(); // consumir para liberar socket
        return fetchHtml(next, hops + 1).then(resolve, reject);
      }

      // OK
      if (code >= 200 && code < 300) {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        return;
      }

      reject(new Error(`HTTP ${code} al descargar ${rawUrl}`));
    });

    req.on('timeout', () => {
      req.destroy(new Error('Timeout al descargar snapshot HTML'));
    });
    req.on('error', reject);
  });
}

/**
 * Genera el HTML del snapshot con un banner de auditoría.
 */
function buildSnapshotHtml({ rawHtmlBuffer, title, acceptedAtISO, email, ip, userAgent, extra = {} }) {
  const raw = rawHtmlBuffer ? rawHtmlBuffer.toString('utf8') : '';
  const banner = `
<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snapshot: ${title || ''}</title>
</head><body>
<!-- Snapshot Laboroteca (evidencia de aceptación) -->
<div style="border:1px solid #ddd;padding:12px;margin:12px 0;font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;background:#fafafa">
  <div><strong>Este es un snapshot de evidencia</strong>; no reemplaza al documento vivo.</div>
  <div>Aceptado: <code>${acceptedAtISO}</code></div>
  <div>Email: <code>${email || ''}</code> · IP: <code>${ip || ''}</code></div>
  <div>User-Agent: <code>${(userAgent || '').substring(0,160)}</code></div>
  <div>Extra: <code>${JSON.stringify(extra)}</code></div>
</div>
<hr>
`;
  const suffix  = raw.includes('</body>') ? '' : '</body>';
  const suffix2 = raw.includes('</html>') ? '' : '</html>';
  return Buffer.from(banner + raw + suffix + suffix2, 'utf8');
}

/**
 * Guarda un HTML en GCS. Si es "general por versión", no lo sobreescribe si ya existe.
 */
async function uploadHtmlToGCS({ path, htmlBuffer, metadata, skipIfExists = false }) {
  const bucket = getBucket();
  if (!bucket) throw new Error('No hay bucket configurado para consents (GCS_CONSENTS_BUCKET / GCS_BUCKET)');

  const file = bucket.file(path);

  if (skipIfExists) {
    try {
      const [exists] = await file.exists();
      if (exists) return path; // ya estaba
    } catch (e) {
      // seguimos e intentamos crear igualmente
    }
  }

  await file.save(htmlBuffer, {
    resumable: false,
    contentType: 'text/html; charset=utf-8',
    metadata: { metadata: { ...metadata } },
    public: false,
    validation: 'md5'
  });

  return path;
}

/**
 * Normaliza y prepara el documento base.
 */
function normalizeInput(payload = {}) {
  const {
    email, nombre, apellidos, userId,
    formularioId, tipoProducto, nombreProducto, descripcionProducto,
    sessionId, paymentIntentId, userAgent, ip, source,
    checkboxes = { privacy: true, terms: true },
    acceptedAt,
    privacyUrl, privacyVersion,
    termsUrl, termsVersion,
    idx
  } = payload;

  let acceptedAtISO = nowISO();
  try {
    if (acceptedAt instanceof Date) acceptedAtISO = acceptedAt.toISOString();
    else if (typeof acceptedAt === 'string' && acceptedAt) acceptedAtISO = new Date(acceptedAt).toISOString();
    else if (typeof acceptedAt === 'number') acceptedAtISO = new Date(acceptedAt).toISOString();
  } catch { /* keep now */ }

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
      terms:   !!(checkboxes && (checkboxes.terms   !== false)),
    },

    acceptedAt: admin.firestore.Timestamp.fromDate(new Date(acceptedAtISO)),
    acceptedAtISO,

    privacyUrl: safe(privacyUrl),
    privacyVersion: safe(privacyVersion),
    termsUrl: safe(termsUrl),
    termsVersion: safe(termsVersion),

    idx: safe(idx),

    // Rutas/flags que se rellenan después
    privacyGeneralBlobPath: '',
    privacyBlobPath: '',
    privacyHash: '',
    privacySnapshotOk: false,

    termsGeneralBlobPath: '',
    termsBlobPath: '',
    termsHash: '',
    termsSnapshotOk: false
  };

  if (doc.privacyUrl) doc.privacyHash = `sha256:${sha256Hex(doc.privacyUrl)}`;
  if (doc.termsUrl)   doc.termsHash   = `sha256:${sha256Hex(doc.termsUrl)}`;

  return doc;
}

function isRegistrationFlow(data) {
  // Registro si: tipoProducto contiene "registro" OR form 5/14 OR source contiene form_5/14
  const tp = (data.tipoProducto || '').toLowerCase();
  const fid = String(data.formularioId || '');
  const src = (data.source || '').toLowerCase();

  if (tp.includes('registro')) return true;
  if (['5','14'].includes(fid)) return true;
  if (/form[_-]?0*(5|14)\b/.test(src)) return true;
  return false;
}

// ───────────────────────────── Core ─────────────────────────────
async function registrarConsentimiento(payload) {
  const data = normalizeInput(payload);

  // Política siempre; T&C sólo si NO es registro y hay datos.
  const registro = isRegistrationFlow(data);

  if (registro) {
    // No registramos T&C en flujos de registro: limpiamos campos de terms para evitar confusiones
    data.termsUrl = '';
    data.termsVersion = '';
    data.termsHash = '';
  }

  // 1) Crear doc inicial
  const col = firestore.collection('consentLogs');
  const initialDocRef = col.doc(); // id aleatorio
  const consentDocId  = initialDocRef.id;

  await initialDocRef.set({ ...data, insertadoEn: nowISO() })
    .catch(async (e) => {
      await alertAdmin(`❌ Error al crear doc consentLogs (${data.email}): ${e.message}`);
      throw e;
    });

  // 2) Preparar IDs/rutas
  const fileId = data.idx || consentDocId; // nombre del snapshot individual

  // 3) Intentar snapshots (si hay bucket)
  let privacyBlobPath = '';
  let privacyGeneralBlobPath = '';
  let privacySnapshotOk = false;

  let termsBlobPath = '';
  let termsGeneralBlobPath = '';
  let termsSnapshotOk = false;

  const bucket = getBucket();

  if (!bucket) {
    await alertAdmin(`ℹ️ Consentimiento sin snapshots (bucket no definido) · ${data.email} · docId=${consentDocId}`);
  } else {
    // Smoke test de permisos (log suave)
    try { await bucket.getMetadata(); } catch (e) {
      await alertAdmin(`❌ No se puede leer metadatos del bucket ${BUCKET_NAME}: ${e.message}`);
    }

    // PRIVACY (siempre que venga url+versión)
    if (data.privacyUrl && data.privacyVersion) {
      try {
        const rawHtml = await fetchHtml(data.privacyUrl);
        const htmlBufIndividual = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Política de Privacidad v${data.privacyVersion}`,
          acceptedAtISO: data.acceptedAtISO,
          email: data.email, ip: data.ip, userAgent: data.userAgent,
          extra: { docId: consentDocId, idx: data.idx, formularioId: data.formularioId, version: data.privacyVersion }
        });

        // 3.a General por versión (no sobreescribir si ya existe)
        const generalPath = `consents/politica-privacidad/${data.privacyVersion}.html`;
        try {
          await uploadHtmlToGCS({
            path: generalPath,
            htmlBuffer: htmlBufIndividual, // vale el mismo contenido con banner
            metadata: {
              kind: 'privacy-general',
              version: data.privacyVersion
            },
            skipIfExists: true
          });
          privacyGeneralBlobPath = generalPath;
        } catch (e) {
          // aviso pero seguimos con el individual
          await alertAdmin(`⚠️ Error subiendo PRIVACY general (${data.email}): ${e.message}`);
        }

        // 3.b Individual por aceptación
        const indivPath = `consents/politica-privacidad/${data.privacyVersion}/${fileId}.html`;
        await uploadHtmlToGCS({
          path: indivPath,
          htmlBuffer: htmlBufIndividual,
          metadata: {
            kind: 'privacy',
            email: data.email,
            consentDocId,
            idx: data.idx,
            ip: data.ip,
            formularioId: data.formularioId,
            version: data.privacyVersion,
            source: data.source,
            userId: data.userId
          }
        });

        privacyBlobPath = indivPath;
        privacySnapshotOk = true;
      } catch (e) {
        await alertAdmin(`⚠️ Error PRIVACY snapshot (${data.email}): ${e.message}`);
      }
    }

    // TERMS (solo si NO es registro y existe url+versión)
    if (!registro && data.termsUrl && data.termsVersion) {
      try {
        const rawHtml = await fetchHtml(data.termsUrl);
        const htmlBufIndividual = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Términos y Condiciones v${data.termsVersion}`,
          acceptedAtISO: data.acceptedAtISO,
          email: data.email, ip: data.ip, userAgent: data.userAgent,
          extra: { docId: consentDocId, idx: data.idx, formularioId: data.formularioId, version: data.termsVersion }
        });

        // 3.a General por versión (no sobreescribir)
        const generalPath = `consents/terminos-condiciones/${data.termsVersion}.html`;
        try {
          await uploadHtmlToGCS({
            path: generalPath,
            htmlBuffer: htmlBufIndividual,
            metadata: {
              kind: 'terms-general',
              version: data.termsVersion
            },
            skipIfExists: true
          });
          termsGeneralBlobPath = generalPath;
        } catch (e) {
          await alertAdmin(`⚠️ Error subiendo TERMS general (${data.email}): ${e.message}`);
        }

        // 3.b Individual
        const indivPath = `consents/terminos-condiciones/${data.termsVersion}/${fileId}.html`;
        await uploadHtmlToGCS({
          path: indivPath,
          htmlBuffer: htmlBufIndividual,
          metadata: {
            kind: 'terms',
            email: data.email,
            consentDocId,
            idx: data.idx,
            ip: data.ip,
            formularioId: data.formularioId,
            version: data.termsVersion,
            source: data.source,
            userId: data.userId
          }
        });

        termsBlobPath = indivPath;
        termsSnapshotOk = true;
      } catch (e) {
        await alertAdmin(`⚠️ Error TERMS snapshot (${data.email}): ${e.message}`);
      }
    }
  }

  // 4) Actualiza doc con rutas/flags y asegura nombre/apellidos
  const updatePayload = {
    privacyGeneralBlobPath,
    privacyBlobPath,
    privacySnapshotOk,

    termsGeneralBlobPath,
    termsBlobPath,
    termsSnapshotOk,

    nombre: data.nombre,
    apellidos: data.apellidos
  };

  await initialDocRef.update(updatePayload)
    .catch(async (e) => {
      await alertAdmin(`❌ Error actualizando consentLogs ${consentDocId}: ${e.message}`);
      throw e;
    });

  // 5) Índice secundario
  try {
    await firestore.collection('consentLogs_idx').doc(consentDocId).set({
      email: data.email,
      nombreCompleto: `${data.nombre} ${data.apellidos}`.trim(),
      acceptedAt: admin.firestore.Timestamp.fromDate(new Date(data.acceptedAtISO)),
      consentId: consentDocId,
      formularioId: data.formularioId,
      idx: data.idx || '',
      privacyVersion: data.privacyVersion,
      termsVersion: registro ? '' : data.termsVersion,
      createdAt: nowISO()
    }, { merge: false });
  } catch (e) {
    await alertAdmin(`⚠️ Error creando índice consentLogs_idx ${consentDocId}: ${e.message}`);
  }

  // 6) Señal si faltó algún snapshot esperado
  const expectedPrivacy = !!data.privacyUrl && !!data.privacyVersion;
  const expectedTerms   = !registro && !!data.termsUrl && !!data.termsVersion;

  if ((expectedPrivacy && !privacySnapshotOk) || (expectedTerms && !termsSnapshotOk)) {
    await alertAdmin(`⚠️ Consent con snapshots incompletos: email=${data.email}, docId=${consentDocId}, privacyOk=${privacySnapshotOk}, termsOk=${termsSnapshotOk}`);
  }

  return {
    docId: consentDocId,
    privacyGeneralBlobPath,
    privacyBlobPath,
    termsGeneralBlobPath,
    termsBlobPath
  };
}

module.exports = {
  registrarConsentimiento,
  logConsent: registrarConsentimiento // alias retrocompatible
};
