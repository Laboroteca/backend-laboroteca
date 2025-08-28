// routes/marketing-consent.js
// ─────────────────────────────────────────────────────────────────────────────
// Registro de consentimiento Newsletter + Comercial (UN SOLO ARCHIVO, 1 colección)
// POST /marketing/consent
// - Auth: x-api-key == process.env.MKT_API_KEY
// - Valida email, consent_marketing y ≥1 materia
// - Rate limit básico (IP+email)
// - Firestore: marketingConsents (merge por email)  ← ÚNICA colección
// - GCS: snapshot HTML del consentimiento (general por versión + individual)
// - Sheets: Consents!A:E (A Nombre, B Email, C Comercial SÍ/NO, D Materias, E Fecha alta)
// - Alertas: utiliza utils/alertAdminProxy
// Requisitos: express, firebase-admin, googleapis
// Entorno:
//   GOOGLE_APPLICATION_CREDENTIALS=<ruta al JSON de servicio>
//   MKT_API_KEY=<clave para x-api-key>
//   GCS_CONSENTS_BUCKET=<bucket GCS> (opcional pero recomendado)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { google } = require('googleapis');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

// ───────── CONFIG ─────────
const API_KEY = (process.env.MKT_API_KEY || '').trim();
const SHEET_ID = '1beWTOMlWjJvtmaGAVDegF2mTts16jZ_nKBrksnEg4Co';
const SHEET_RANGE = 'Consents!A:E'; // A Nombre, B Email, C Comercial, D Materias, E Fecha alta
const BUCKET_NAME =
  (process.env.GCS_CONSENTS_BUCKET ||
   process.env.GCS_BUCKET ||
   process.env.GCLOUD_STORAGE_BUCKET || '').trim();

const MATERIAS_ORDER = [
  'derechos',
  'cotizaciones',
  'desempleo',
  'bajas_ip',
  'jubilacion',
  'ahorro_privado',
  'otras_prestaciones'
];

// ───────── Firebase Admin ─────────
if (!admin.apps.length) { try { admin.initializeApp(); } catch(_){} }
const db = admin.firestore();

// ───────── Helpers ─────────
const s = (v, def='') => (v===undefined || v===null) ? def : String(v).trim();
const sha256Hex = (str) => crypto.createHash('sha256').update(String(str||''), 'utf8').digest('hex');
const nowISO = () => new Date().toISOString();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));

const toBool = (v, def=false) => {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  const sv = String(v).toLowerCase().trim();
  if (['1','true','yes','on','si','sí','checked'].includes(sv)) return true;
  if (['0','false','no','off',''].includes(sv)) return false;
  return def;
};

function requireApiKey(req, res) {
  const key = s(req.headers['x-api-key']);
  if (!API_KEY || key !== API_KEY) {
    res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
    return false;
  }
  return true;
}

function normalizeMaterias(m) {
  const raw = m || {};
  const obj = {};
  let any = false;
  for (const k of MATERIAS_ORDER) {
    const val = toBool(raw[k], false);
    obj[k] = val;
    if (val) any = true;
  }
  return { obj, any };
}

const materiasToList = (obj) => MATERIAS_ORDER.filter(k => !!obj[k]);
const materiasToString = (obj) => {
  const list = materiasToList(obj);
  return list.length ? list.join(' / ') : '—';
};

// Descargar HTML (con redirecciones) para snapshot
function fetchHtml(rawUrl, hops=0) {
  return new Promise((resolve, reject) => {
    if (!rawUrl) return reject(new Error('NO_URL'));
    let parsed; try { parsed = new URL(rawUrl); } catch(e){ return reject(e); }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + (parsed.search || ''),
      headers: { 'User-Agent':'LaborotecaSnapshot/1.0', 'Accept':'text/html,application/xhtml+xml' },
      timeout: 15000
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301,302,303,307,308].includes(code) && res.headers.location) {
        if (hops >= 5) return reject(new Error('TOO_MANY_REDIRECTS'));
        const next = new URL(res.headers.location, rawUrl).toString();
        res.resume();
        return fetchHtml(next, hops+1).then(resolve,reject);
      }
      if (code >= 200 && code < 300) {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        return;
      }
      reject(new Error(`HTTP_${code}`));
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
  });
}

function buildSnapshotHtml({ rawHtmlBuffer, title, acceptedAtISO, email, ip, userAgent, extra={} }) {
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

function getBucket() {
  if (!BUCKET_NAME) return null;
  try { return admin.storage().bucket(BUCKET_NAME); }
  catch { return null; }
}

async function uploadHtmlToGCS({ path, htmlBuffer, metadata, skipIfExists=false }) {
  const bucket = getBucket();
  if (!bucket) return null;
  const file = bucket.file(path);
  if (skipIfExists) {
    try { const [exists] = await file.exists(); if (exists) return path; } catch {}
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

// Sheets
async function getSheetsClient(){
  const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function upsertConsentRow({ nombre, email, comercialYES, materiasStr, fechaAltaISO }) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  const rows = res.data.values || [];

  // Buscar última fila que coincida por email (col B, idx 1)
  let targetIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i][1] || '').toLowerCase() === email.toLowerCase()) { targetIdx = i; break; }
  }

  if (targetIdx >= 0) {
    const rowNum = targetIdx + 1;
    // Actualizar A–D; E solo si estaba vacío
    const currentE = rows[targetIdx][4] || '';
    const values = [
      [ nombre || (rows[targetIdx][0] || ''), email, comercialYES, materiasStr, currentE || fechaAltaISO ]
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Consents!A${rowNum}:E${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return { updatedRow: rowNum };
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[ nombre || '', email, comercialYES, materiasStr, fechaAltaISO ]]
      }
    });
    return { appended: true };
  }
}

// ───────── Rate limit básico (IP + email) ─────────
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const RATE_MAX = 8; // máximo de 8 altas/updates por ventana
const rlStore = new Map(); // clave: ip|email → { count, resetAt }

function checkRateLimit(ip, email){
  const key = `${ip}|${email.toLowerCase()}`;
  const now = Date.now();
  const entry = rlStore.get(key);
  if (!entry || now > entry.resetAt) {
    rlStore.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

// ───────── Ruta principal ─────────
router.post('/marketing/consent', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const ts = nowISO();

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').slice(0,180);

  try {
    // Entrada principal
    const email = s(req.body?.email).toLowerCase();
    const nombre = s(req.body?.nombre);
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'EMAIL_REQUIRED' });

    // Rate limit (IP+email)
    if (!checkRateLimit(ip || '0.0.0.0', email)) {
      await alertAdmin(`🚦 Rate limit newsletter alcanzado`, { email, ip });
      return res.status(429).json({ ok:false, error:'RATE_LIMIT' });
    }

    const { obj: materias, any } = normalizeMaterias(req.body?.materias);
    if (!any) return res.status(400).json({ ok:false, error:'MATERIAS_REQUIRED' });

    const consent_marketing = toBool(req.body?.consent_marketing, false);
    if (!consent_marketing) return res.status(400).json({ ok:false, error:'CONSENT_MARKETING_REQUIRED' });

    const consent_comercial = toBool(req.body?.consent_comercial, false);

    // ConsentData (JSON plano desde formulario)
    let consentData = {};
    try {
      if (typeof req.body?.consentData === 'string') consentData = JSON.parse(req.body.consentData);
      else if (typeof req.body?.consentData === 'object') consentData = (req.body.consentData || {});
    } catch { consentData = {}; }

    const consentUrl = s(consentData.consentUrl, 'https://www.laboroteca.es/consentimiento-newsletter/');
    const consentVersion = s(consentData.consentVersion, 'v1.0');
    // El hash real lo calculamos sobre el HTML descargado
    let consentTextHash = '';

    const sourceForm = s(req.body?.sourceForm, 'preferencias_marketing');
    const formularioId = s(req.body?.formularioId);
    const userAgent = ua;
    const ipAddr = ip;

    // Snapshot GCS (opcional)
    let snapshotIndividualPath = '';
    let snapshotGeneralPath = '';
    try {
      if (!BUCKET_NAME) {
        // Sin bucket configurado: avisar una vez
        await alertAdmin('ℹ️ Newsletter: BUCKET_NAME no configurado; no se guardarán snapshots', {});
      } else {
        const rawHtml = await fetchHtml(consentUrl);
        consentTextHash = `sha256:${sha256Hex(rawHtml)}`;
        const htmlBuf = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Consentimiento Newsletter ${consentVersion}`,
          acceptedAtISO: ts, email, ip: ipAddr, userAgent,
          extra: { consentVersion, sourceForm, formularioId }
        });

        // General por versión (no sobreescribir si ya existe)
        const generalPath = `consents/newsletter/${consentVersion}.html`;
        await uploadHtmlToGCS({
          path: generalPath,
          htmlBuffer: htmlBuf,
          metadata: { kind:'newsletter-general', version: consentVersion },
          skipIfExists: true
        });
        snapshotGeneralPath = generalPath;

        // Individual por aceptación
        const individualId = sha256Hex(`${email}.${ts}.${Math.random()}`);
        const indivPath = `consents/newsletter/${consentVersion}/${individualId}.html`;
        await uploadHtmlToGCS({
          path: indivPath,
          htmlBuffer: htmlBuf,
          metadata: {
            kind:'newsletter',
            email, consentVersion, sourceForm, formularioId, ip: ipAddr, userAgent
          }
        });
        snapshotIndividualPath = indivPath;
      }
    } catch (e) {
      console.warn('Snapshot error:', e?.message || e);
      try { await alertAdmin(`⚠️ Error guardando snapshot de consentimiento`, { email, consentUrl, err: e?.message || String(e) }); } catch {}
      // seguimos sin bloquear el alta
    }

    // Firestore: marketingConsents (docId = email)
    const mcRef = db.collection('marketingConsents').doc(email);
    let createdAt = admin.firestore.Timestamp.fromDate(new Date());
    try {
      const mcSnap = await mcRef.get();
      if (mcSnap.exists) createdAt = mcSnap.data().createdAt || createdAt;

      const docMarketing = {
        email,
        nombre,
        consent_marketing: true,
        consent_comercial,
        materias,
        materiasList: materiasToList(materias),
        consentVersion,
        consentTextHash,
        newsletterUrl: consentUrl,
        sourceForm,
        formularioId,
        lastIp: ipAddr,
        lastUA: userAgent,
        updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAt
      };
      await mcRef.set(docMarketing, { merge: true });
    } catch (e) {
      console.error('Firestore set error:', e?.message || e);
      try { await alertAdmin(`❌ Error guardando marketingConsents`, { email, err: e?.message || String(e) }); } catch {}
      return res.status(500).json({ ok:false, error:'FIRESTORE_WRITE_FAILED' });
    }

    // Sheets: upsert fila A–E
    const comercialYES = consent_comercial ? 'SÍ' : 'NO';
    const materiasStr = materiasToString(materias);
    try {
      await upsertConsentRow({
        nombre,
        email,
        comercialYES,
        materiasStr,
        fechaAltaISO: ts
      });
    } catch (e) {
      console.warn('Sheets upsert warn:', e?.message || e);
      try { await alertAdmin(`⚠️ No se pudo actualizar Google Sheets (alta newsletter)`, { email, err: e?.message || String(e) }); } catch {}
      // no bloqueamos respuesta por fallo de Sheets
    }

    return res.json({
      ok: true,
      flow: 'newsletter',
      email,
      consent_comercial,
      materias: materiasToList(materias),
      consentVersion,
      snapshotGeneralPath,
      snapshotIndividualPath
    });

  } catch (err) {
    console.error('marketing/consent error:', err?.message || err);
    try { await alertAdmin(`🔥 Error inesperado en /marketing/consent`, { err: err?.message || String(err) }); } catch {}
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;

/* Montaje:
   const express = require('express');
   const app = express();
   app.use(express.json());
   app.use(require('./routes/marketing-consent'));
   app.listen(process.env.PORT || 3000);

Fluent Forms – campos relevantes:
  • email           → (visible, editable) → Email de ENVÍO (único email que guardamos)
  • nombre
  • materias[...]   → derechos, cotizaciones, desempleo, bajas_ip, jubilacion, ahorro_privado, otras_prestaciones
  • consent_marketing (obligatorio)
  • consent_comercial (opcional)
  • consentData (JSON) → { trigger:1, consentUrl:"https://www.laboroteca.es/consentimiento-newsletter/", consentVersion:"v1.0", consentTextHash:"" }
  • sourceForm, formularioId
  • ip={remote_ip}, ua={user_agent}
*/
