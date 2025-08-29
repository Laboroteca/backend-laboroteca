// routes/marketing-consent.js
// ─────────────────────────────────────────────────────────────────────────────
// Alta de consentimiento Newsletter (y opcional Comercial) con seguridad
// de producción: API Key + HMAC, anti-replay, rate limit, snapshots GCS,
// alta/merge en Firestore, upsert en Google Sheets y email de bienvenida.
// 
// POST /marketing/consent
//  Headers:
//    - x-api-key        = MKT_API_KEY
//    - x-lb-ts          = epoch seconds (HMAC window)
//    - x-lb-sig         = hex(HMAC_SHA256( MKT_CONSENT_SECRET, `${ts}.${rawBodySha256}` ))
//  Body (FF típico):
//    { email, nombre, materias:[...]/obj, consent_marketing:true, consent_comercial:false,
//      consentData:{ consentUrl, consentVersion }, sourceForm?, formularioId? }
//
// Entorno mínimo:
//  - GOOGLE_APPLICATION_CREDENTIALS=... (Sheets/GCS)
//  - MKT_API_KEY=xxxx
//  - MKT_CONSENT_SECRET=xxxx
//  - SMTP2GO_API_KEY=xxxx
//  - EMAIL_FROM, EMAIL_FROM_NAME
//  - MKT_UNSUB_SECRET=xxxx
//  - MKT_UNSUB_PAGE=https://www.laboroteca.es/baja-newsletter/
//   GOOGLE_CLOUD_BUCKET=... (o GCS_CONSENTS_BUCKET/GCS_BUCKET/GCLOUD_STORAGE_BUCKET)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');
const { URL } = require('url');
const { google } = require('googleapis');
const fetch   = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

// ───────── CONFIG ─────────
const API_KEY   = String(process.env.MKT_API_KEY || '').trim();
const HMAC_SEC  = String(process.env.MKT_CONSENT_SECRET || '').trim();
const DEBUG     = String(process.env.MKT_DEBUG || '').trim() === '1';

const SHEET_ID   = '1beWTOMlWjJvtmaGAVDegF2mTts16jZ_nKBrksnEg4Co';
const SHEET_READ_RANGE  = 'Consents!A:E'; // A Nombre, B Email, C Comercial, D Materias, E Fecha alta
const SHEET_WRITE_RANGE = 'Consents!A:E';

// Bucket: prioriza tu GOOGLE_CLOUD_BUCKET; mantiene otros alias como fallback
const BUCKET_NAME =
  (process.env.GOOGLE_CLOUD_BUCKET ||
   process.env.GCS_CONSENTS_BUCKET ||
   process.env.GCS_BUCKET ||
   process.env.GCLOUD_STORAGE_BUCKET || '').trim();

const SMTP2GO_API_KEY = String(process.env.SMTP2GO_API_KEY || '').trim();
const FROM_EMAIL      = String(process.env.EMAIL_FROM || 'newsletter@laboroteca.es').trim();
const FROM_NAME       = String(process.env.EMAIL_FROM_NAME || 'Laboroteca Newsletter').trim();

const UNSUB_SECRET = String(process.env.MKT_UNSUB_SECRET || 'laboroteca-unsub').trim();
const UNSUB_PAGE   = String(process.env.MKT_UNSUB_PAGE   || 'https://www.laboroteca.es/baja-newsletter/').trim();

const IP_ALLOW  = String(process.env.CONSENT_IP_ALLOW || '').trim(); // ej: "1.2.3.4, 5.6.7.8"
const MAX_PER_10M = Number(process.env.CONSENT_MAX_PER_10M || 8);    // rate por ip+email
const HMAC_WINDOW_S = 5 * 60; // ±5 minutos

const MATERIAS_ORDER = [
  'derechos',
  'cotizaciones',
  'desempleo',
  'bajas_ip',
  'jubilacion',
  'ahorro_privado',
  'otras_prestaciones'
];

const MATERIAS_MATCHERS = [
  ['derechos',           [/derech/i]],
  ['cotizaciones',       [/cotiza/i]],
  ['desempleo',          [/desemple/i]],
  ['bajas_ip',           [/baja/i, /incapac/i]],
  ['jubilacion',         [/jubil/i]],
  ['ahorro_privado',     [/ahorro/i, /plan/i, /pensi/i, /invers/i]],
  ['otras_prestaciones', [/otras/i, /prestac/i]]
];

// ───────── Firebase Admin ─────────
if (!admin.apps.length) { try { admin.initializeApp(); } catch(_){} }
const db = admin.firestore();

// ───────── Helpers ─────────
const s = (v, def='') => (v===undefined || v===null) ? def : String(v).trim();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));
const nowISO = () => new Date().toISOString();
const sha256HexBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256Hex = (str) => crypto.createHash('sha256').update(String(str||''), 'utf8').digest('hex');

const toBool = (v, def=false) => {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  const sv = String(v).toLowerCase().trim();
  if (['1','true','yes','on','si','sí','checked'].includes(sv)) return true;
  if (['0','false','no','off',''].includes(sv)) return false;
  return def;
};

function clientIp(req){
  return (req.headers['x-forwarded-for'] || req.ip || '')
    .toString().split(',')[0].trim();
}

function requireApiKey(req, res) {
  const key = s(req.headers['x-api-key']);
  if (!API_KEY || key !== API_KEY) {
    if (DEBUG) {
      console.warn('⛔ API KEY mismatch en /marketing/consent · present=%s match=%s',
        !!key, key === API_KEY);
    }
    res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
    return false;
  }
  return true;
}

// HMAC: x-lb-ts (epoch s) + x-lb-sig = HMAC(ts+'.'+sha256(rawBody))
function verifyHmac(req){
  if (!HMAC_SEC) return false; // si no hay secreto, no podemos verificar
  const ts = Number(s(req.headers['x-lb-ts']));
  const sig = s(req.headers['x-lb-sig']);
  if (!ts || !sig) return false;

  const now = Math.floor(Date.now()/1000);
  if (Math.abs(now - ts) > HMAC_WINDOW_S) return false;

  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}),'utf8');
  const rawHash = sha256HexBuf(raw);
  const expect = crypto.createHmac('sha256', HMAC_SEC).update(`${ts}.${rawHash}`).digest('hex');

  try {
    const ok = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expect, 'hex'));
    if (!ok && DEBUG) {
      console.warn('⛔ HMAC BAD · ts=%s · rawLen=%s · providedSigLen=%s',
        ts, raw.length, sig.length);
    }
    return ok;
  } catch {
    if (DEBUG) console.warn('⛔ HMAC compare error (bad hex?)');
    return false;
  }
}

// Normaliza materias desde array de textos u objeto booleano
function normalizeMaterias(input, bodyFallback = {}) {
  const out = Object.fromEntries(MATERIAS_ORDER.map(k => [k, false]));
  // 1) array de labels
  if (Array.isArray(input)) {
    for (const raw of input) {
      const txt = s(raw).toLowerCase();
      for (const [slug, patterns] of MATERIAS_MATCHERS) {
        if (patterns.some(rx => rx.test(txt))) out[slug] = true;
      }
    }
    return { obj: out, any: Object.values(out).some(Boolean) };
  }
  // 2) objeto booleano
  if (input && typeof input === 'object') {
    for (const k of MATERIAS_ORDER) out[k] = toBool(input[k], out[k]);
    return { obj: out, any: Object.values(out).some(Boolean) };
  }
  // 3) claves sueltas en body
  for (const k of MATERIAS_ORDER) out[k] = toBool(bodyFallback[k] ?? bodyFallback[`materias_${k}`], out[k]);
  return { obj: out, any: Object.values(out).some(Boolean) };
}

const materiasToList   = (obj) => MATERIAS_ORDER.filter(k => !!obj[k]);
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

console.log('🗄  BUCKET (consents):', BUCKET_NAME ? `set (${BUCKET_NAME})` : 'not set');

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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_READ_RANGE });
  const rows = res.data.values || [];

  // Buscar última fila que coincida por email (col B, idx 1)
  let targetIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i][1] || '').toLowerCase() === email.toLowerCase()) { targetIdx = i; break; }
  }

  if (targetIdx >= 0) {
    const rowNum = targetIdx + 1;
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
      range: SHEET_WRITE_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[ nombre || '', email, comercialYES, materiasStr, fechaAltaISO ]]
      }
    });
    return { appended: true };
  }
}

// Email
function tpl(str, data = {}) {
  if (!str) return str;
  return str
    .replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => data[k] ?? '')
    .replace(/\{\s*([A-Z0-9_]+)\s*\}/gi,     (_, k) => data[k] ?? '')
    .replace(/%([A-Z0-9_]+)%/gi,             (_, k) => data[k] ?? '');
}

async function sendSMTP2GO({ to, subject, html }) {
  if (!SMTP2GO_API_KEY) throw new Error('SMTP2GO_API_KEY missing');

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: Array.isArray(to) ? to : [to],
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    html_body: html
  };

  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(()=> ({}));
  const ok = res.ok && (Array.isArray(data?.data?.succeeded) ? data.data.succeeded.length > 0 : true);
  if (!ok) throw new Error(`SMTP2GO failed: ${JSON.stringify(data)}`);
  return data;
}

// Token de baja: base64url(email.ts).firma(hmac)
function makeUnsubToken(email) {
  const ts = Math.floor(Date.now()/1000);
  const base = `${String(email||'').toLowerCase()}.${ts}`;
  const sig  = crypto.createHmac('sha256', UNSUB_SECRET).update(base).digest('hex').slice(0,32);
  const payload = Buffer.from(base).toString('base64url');
  return `${payload}.${sig}`;
}

// ───────── Rate limit básico (IP + email) ─────────
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const rlStore = new Map(); // clave: ip|email → { count, resetAt }

function checkRateLimit(ip, email){
  const limit = Number.isFinite(MAX_PER_10M) ? MAX_PER_10M : 8;
  const key = `${ip}|${String(email||'').toLowerCase()}`;
  const now = Date.now();
  const entry = rlStore.get(key);
  if (!entry || now > entry.resetAt) {
    rlStore.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ───────── Ruta principal ─────────
router.post('/consent', async (req, res) => {
  // Log de entrada muy temprano
  if (DEBUG) {
    const ip0 = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    console.log('🟢 [/marketing/consent] ENTER ip=%s ua=%s rawLen=%s hasAPI=%s hasHMAC=%s',
      ip0, (req.headers['user-agent'] || '').slice(0,120),
      Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0,
      !!req.headers['x-api-key'],
      !!req.headers['x-lb-sig']
    );
  }
  // API Key
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0,180);

  // IP allowlist opcional (modo cerrado)
  if (IP_ALLOW) {
    const allow = new Set(IP_ALLOW.split(',').map(x => x.trim()).filter(Boolean));
    if (!allow.has(ip)) return res.status(403).json({ ok:false, error:'IP_FORBIDDEN' });
  }

  // HMAC: si viene del bridge interno, lo permitimos aunque falle la verificación.
  const isInternalBridge = req.headers['x-internal-bridge'] === '1' &&
    (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
  if (HMAC_SEC && !isInternalBridge && !verifyHmac(req)) {
    console.warn('⛔ BAD_HMAC en /marketing/consent ip=%s', ip);
    return res.status(401).json({ ok:false, error:'BAD_HMAC' });
  }

  const ts = nowISO();

  try {
    // Parsing básico
    const email  = s(req.body?.email).toLowerCase();
    const nombre = s(req.body?.nombre);

    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'EMAIL_REQUIRED' });

    console.log(`🟢 [/marketing/consent] email=${email} formId=${s(req.body?.formularioId)} ip=${ip} internal=${isInternalBridge}`);

    // Rate limit (IP+email)
    if (!checkRateLimit(ip || '0.0.0.0', email)) {
      await alertAdmin(`🚦 Rate limit newsletter alcanzado`, { email, ip });
      return res.status(429).json({ ok:false, error:'RATE_LIMIT' });
    }

    const { obj: materias, any } = normalizeMaterias(req.body?.materias, req.body || {});
    if (!any) return res.status(400).json({ ok:false, error:'MATERIAS_REQUIRED' });

    const consent_marketing = toBool(req.body?.consent_marketing ?? req.body?.privacy, false);
    if (!consent_marketing) return res.status(400).json({ ok:false, error:'CONSENT_MARKETING_REQUIRED' });

    const consent_comercial = toBool(req.body?.consent_comercial, false);

    // ConsentData (JSON plano desde formulario)
    let consentData = {};
    try {
      if (typeof req.body?.consentData === 'string') consentData = JSON.parse(req.body.consentData);
      else if (typeof req.body?.consentData === 'object') consentData = (req.body.consentData || {});
    } catch { consentData = {}; }

    const consentUrl     = s(consentData.consentUrl, 'https://www.laboroteca.es/consentimiento-newsletter/');
    const consentVersion = s(consentData.consentVersion, 'v1.0');
    let consentTextHash  = '';

    const sourceForm   = s(req.body?.sourceForm, 'preferencias_marketing');
    const formularioId = s(req.body?.formularioId);
    const userAgent    = ua;
    const ipAddr       = ip;

    // Snapshot GCS (opcional)
    let snapshotIndividualPath = '';
    let snapshotGeneralPath = '';
    try {
      if (!BUCKET_NAME) {
        await alertAdmin('ℹ️ Newsletter: BUCKET_NAME no configurado (revisa GOOGLE_CLOUD_BUCKET); no se guardarán snapshots', {});
      } else {
        const rawHtml  = await fetchHtml(consentUrl);
        consentTextHash = `sha256:${sha256HexBuf(rawHtml)}`;

        const htmlBuf = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Consentimiento Newsletter ${consentVersion}`,
          acceptedAtISO: ts, email, ip: ipAddr, userAgent,
          extra: { consentVersion, sourceForm, formularioId }
        });

        const generalPath = `consents/newsletter/${consentVersion}.html`;
        await uploadHtmlToGCS({
          path: generalPath,
          htmlBuffer: htmlBuf,
          metadata: { kind:'newsletter-general', version: consentVersion },
          skipIfExists: true
        });
        snapshotGeneralPath = generalPath;

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
    }

    // Firestore: marketingConsents (docId = email) – idempotente
    const mcRef = db.collection('marketingConsents').doc(email);
    let createdAt = admin.firestore.Timestamp.fromDate(new Date());

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(mcRef);
        if (snap.exists) {
          const prev = snap.data() || {};
          createdAt = prev.createdAt || createdAt;
        }
        tx.set(mcRef, {
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
        }, { merge: true });
      });
    } catch (e) {
      console.error('Firestore set error:', e?.message || e);
      try { await alertAdmin(`❌ Error guardando marketingConsents`, { email, err: e?.message || String(e) }); } catch {}
      return res.status(500).json({ ok:false, error:'FIRESTORE_WRITE_FAILED' });
    }

    // Aviso de éxito
    try { await alertAdmin(`✅ Alta newsletter`, { email, materias: materiasToList(materias) }); } catch {}

    // Sheets: upsert fila A–E (no bloqueante)
    const comercialYES = consent_comercial ? 'SÍ' : 'NO';
    const materiasStr  = materiasToString(materias);
    upsertConsentRow({ nombre, email, comercialYES, materiasStr, fechaAltaISO: ts })
      .catch(async (e) => {
        console.warn('Sheets upsert warn:', e?.message || e);
        try { await alertAdmin(`⚠️ No se pudo actualizar Google Sheets (alta newsletter)`, { email, err: e?.message || String(e) }); } catch {}
      });
    if (DEBUG) console.log('📊 Sheets: upsert encolado para %s', email);
    // Email de bienvenida (no bloqueante)
    (async () => {
      try {
        const token   = makeUnsubToken(email);
        const unsubUrl = `${UNSUB_PAGE}${UNSUB_PAGE.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

        const nombreSafe = nombre || (email.split('@')[0] || '').replace(/[._-]+/g, ' ');
        const tokens = { NOMBRE: nombreSafe };

        const subject = tpl('¡Bienvenido a la newsletter de Laboroteca, {NOMBRE}!', tokens);
        const bodyTop = tpl(
          `<p>Hola {NOMBRE},</p>
           <p>¡Gracias por suscribirte a la newsletter de <strong>Laboroteca</strong>!</p>
           <p>Desde ahora recibirás novedades por email sobre las materias que has seleccionado.
           Puedes visitar nuestro <a href="https://www.laboroteca.es/boletin-informativo/">Boletín</a>.</p>
           <p>Si en algún momento quieres cambiar tus preferencias o darte de baja, podrás hacerlo desde el enlace incluido en cada email.</p>`,
          tokens
        );
        const legal =
          `<hr style="border:0;height:1px;width:100%;background:#e5e5e5;margin:16px 0;">
           <p style="color:#6b6b6b;font-size:12px;line-height:1.5;margin:0 0 8px">
             Este mensaje se ha enviado a <strong>${email}</strong> porque te has dado de alta en la newsletter.
             Si no deseas seguir recibiéndola, puedes <a href="${unsubUrl}">darte de baja aquí</a>.
           </p>
           <p style="color:#6b6b6b;font-size:12px;line-height:1.5">
             En cumplimiento del Reglamento (UE) 2016/679 (RGPD), tu email forma parte de la base de datos de
             <strong>Ignacio Solsona Fernández-Pedrera</strong>. Puedes ejercer tus derechos en
             <a href="mailto:ignacio.solsona@icacs.com">ignacio.solsona@icacs.com</a>.
           </p>`;
        const smtpRes = await sendSMTP2GO({ to: email, subject, html: bodyTop + legal });
        if (DEBUG) console.log('📧 Welcome email OK → %s (%s)', email, smtpRes?.request_id || 'no-id');
      } catch (e) {
        console.warn('Welcome email failed:', e?.message || e);
        try { await alertAdmin(`⚠️ Fallo enviando email de bienvenida newsletter`, { email, err: e?.message || String(e) }); } catch {}
      }
    })();

    // Respuesta OK
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

/* Campos esperados (Fluent Forms):
  • email           (obligatorio)
  • nombre
  • materias (array de textos o {derechos,cotizaciones,desempleo,bajas_ip,jubilacion,ahorro_privado,otras_prestaciones})
  • consent_marketing (obligatorio; alias aceptado: privacy)
  • consent_comercial (opcional)
  • consentData (JSON) → { consentUrl, consentVersion }
  • sourceForm, formularioId (opcionales)
*/
