'use strict';

/**
 * routes/marketing-consent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Alta de consentimiento Newsletter (y opcional Comercial) con seguridad
 * de producción: API Key + HMAC (o bridge interno), anti-replay, rate limit,
 * snapshots GCS, upsert en Firestore, upsert en Google Sheets y email de
 * bienvenida por SMTP2GO.
 *
 * POST /marketing/consent
 *  Headers:
 *    - x-api-key  = MKT_API_KEY (siempre; también se acepta Authorization: Bearer ...)
 *    - x-lab-ts   = epoch seconds|ms   (o x-lb-ts legacy)
 *    - x-lab-sig  = hex(HMAC_SHA256( base ))  (o x-lb-sig legacy)
 *      base v2: `${ts}.${METHOD}.${PATH}.${sha256(body)}`
 *      base v1 legacy: `${ts}.${sha256(body)}`
 *    - x-request-id (opcional; activa anti-replay interno)
 *    - x-internal-bridge: 1  (permite saltar HMAC puro si viene por bridge interno)
 *
 * Body (FF típico):
 *   {
 *     email, nombre,
 *     materias: array<Text>|obj booleans|labels (OBLIGATORIO ≥1),
 *     consent_marketing: true  (OBLIGATORIO),
 *     consent_comercial: false (opcional),
 *     consentData:{ consentUrl, consentVersion },                 // newsletter
 *     consentDataComercial?:{ consentUrl, consentVersion },       // publicidad opcional
 *     sourceForm?, formularioId?, ip?, ua?, skipConsentLogs?
 *   }
 *
 * Entorno mínimo:
 *  - GOOGLE_APPLICATION_CREDENTIALS=... (Sheets/GCS)
 *  - MKT_API_KEY=xxxx
 *  - MKT_CONSENT_SECRET=xxxx
 *  - SMTP2GO_API_KEY=xxxx
 *  - EMAIL_FROM, EMAIL_FROM_NAME
 *  - MKT_UNSUB_SECRET=xxxx
 *  - MKT_UNSUB_PAGE=https://www.laboroteca.es/baja-newsletter/
 *  - GOOGLE_CLOUD_BUCKET o GCS_CONSENTS_BUCKET/GCS_BUCKET/GCLOUD_STORAGE_BUCKET
 *  - MKT_DEBUG=1 (opcional para logs verbosos)
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

/* ───────── CONFIG ───────── */

const API_KEY   = String(process.env.MKT_API_KEY || '').trim();
const HMAC_SEC  = String(process.env.MKT_CONSENT_SECRET || '').trim();
const DEBUG     = String(process.env.MKT_DEBUG || '').trim() === '1';

const SHEET_ID   = '1beWTOMlWjJvtmaGAVDegF2mTts16jZ_nKBrksnEg4Co';
const SHEET_READ_RANGE  = 'Consents!A:E'; // A Nombre, B Email, C Comercial, D Materias, E Fecha alta
const SHEET_WRITE_RANGE = 'Consents!A:E';

// Bucket: prioriza GOOGLE_CLOUD_BUCKET; mantiene otros alias como fallback
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
const HMAC_WINDOW_MS = 5 * 60 * 1000; // ±5 minutos en ms (aceptamos s o ms)

/* ───────── Materias ───────── */

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

/* ───────── Firebase Admin ───────── */

if (!admin.apps.length) { try { admin.initializeApp(); } catch(_){} }
const db = admin.firestore();

/* ───────── Helpers ───────── */

const s = (v, def='') => (v===undefined || v===null) ? def : String(v).trim();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));
const nowISO = () => new Date().toISOString();

const sha256HexBuf = (buf) => crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
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

/* API key desde múltiples vías: header, bearer, query, body */
function requireApiKey(req, res) {
  let provided = s(req.headers['x-api-key']);
  if (!provided) {
    const auth = s(req.headers['authorization']);
    if (auth.toLowerCase().startsWith('bearer ')) provided = s(auth.slice(7));
  }
  if (!provided) provided = s(req.query?.api_key);
  if (!provided && req.body) provided = s(req.body.api_key);

  const ok = !!API_KEY && provided === API_KEY;
  if (!ok) {
    if (DEBUG) console.warn('⛔ API KEY mismatch · expected=%s present=%s', API_KEY ? '(set)' : '(unset)', provided ? '(present)' : '(absent)');
    res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
    return false;
  }
  return true;
}

/* HMAC flexible: acepta x-lab-* y x-lb-*; formato v2 (ts.METHOD.PATH.sha256(body)) o v1 (ts.sha256(body)); ts en s o ms */
function normalizePath(p) {
  try {
    p = (p || '/').toString();
    p = p.split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    return p.replace(/\/{2,}/g, '/');
  } catch { return '/'; }
}
function verifyHmacFlexible(req){
  if (!HMAC_SEC) return true; // si no hay secreto, no bloqueamos
  const headers = req.headers || {};
  const pick = (h) => headers[h] || headers[h.replace(/-/g,'_')] || headers[h.replace(/_/g,'-')];

  const tsHeader  = String(pick('x-lab-ts') || pick('x-lb-ts') || '');
  const sigHeader = String(pick('x-lab-sig') || pick('x-lb-sig') || '');
  const reqId     = String(pick('x-request-id') || '');

  if (!tsHeader || !sigHeader) return false;
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) return false;

  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return false;
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000;

  if (Math.abs(Date.now() - tsMs) > HMAC_WINDOW_MS) return false;

  const raw = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const bodyHash = sha256HexBuf(raw);

  const method = String(req.method || 'POST').toUpperCase();
  const path   = normalizePath(req.path);

  const tsSec = Math.floor(tsMs / 1000);
  const tsMsInt = Math.floor(tsMs);

  const bases = [
    `${tsSec}.${method}.${path}.${bodyHash}`,
    `${tsMsInt}.${method}.${path}.${bodyHash}`,
    `${tsSec}.${bodyHash}`,
    `${tsMsInt}.${bodyHash}`,
  ];

  const sigBuf = Buffer.from(sigHeader, 'hex');
  for (const base of bases) {
    const exp = crypto.createHmac('sha256', HMAC_SEC).update(base).digest('hex');
    const expBuf = Buffer.from(exp, 'hex');
    if (expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) {
      return true;
    }
  }
  return false;
}

/* Materias: normalización a objeto booleano ordenado + validación any=true */
function normalizeMaterias(input, bodyFallback = {}) {
  const out = Object.fromEntries(MATERIAS_ORDER.map(k => [k, false]));

  // fallback: "checkboxes": array de labels
  if (!input && Array.isArray(bodyFallback.checkboxes)) {
    input = bodyFallback.checkboxes;
  }

  // 1) array de labels/strings
  if (Array.isArray(input)) {
    for (const raw of input) {
      const txt = s(raw).toLowerCase();
      for (const [slug, patterns] of MATERIAS_MATCHERS) {
        if (patterns.some(rx => rx.test(txt))) out[slug] = true;
      }
    }
    return { obj: out, any: Object.values(out).some(Boolean) };
  }

  // 2) objeto booleano {slug:true/false}
  if (input && typeof input === 'object') {
    for (const k of MATERIAS_ORDER) out[k] = toBool(input[k], out[k]);
    return { obj: out, any: Object.values(out).some(Boolean) };
  }

  // 3) claves sueltas en body (materias_k)
  for (const k of MATERIAS_ORDER) out[k] = toBool(bodyFallback[k] ?? bodyFallback[`materias_${k}`], out[k]);
  return { obj: out, any: Object.values(out).some(Boolean) };
}
const materiasToList   = (obj) => MATERIAS_ORDER.filter(k => !!obj[k]);
const materiasToString = (obj) => {
  const list = materiasToList(obj);
  return list.length ? list.join(' / ') : '—';
};

/* Descargar HTML (con redirecciones) para snapshot */
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

if (DEBUG) {
  console.log('🗄  BUCKET (consents):', BUCKET_NAME ? `set (${BUCKET_NAME})` : 'not set');
  console.log('🔐 SMTP2GO key present:', !!SMTP2GO_API_KEY);
  console.log('📧 FROM:', `${FROM_NAME} <${FROM_EMAIL}>`);
  console.log('📊 SHEET_ID present:', !!SHEET_ID);
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

/* Sheets */
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

/* Email via SMTP2GO */
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

/* Token de baja */
function makeUnsubToken(email) {
  const ts = Math.floor(Date.now()/1000);
  const base = `${String(email||'').toLowerCase()}.${ts}`;
  const sig  = crypto.createHmac('sha256', UNSUB_SECRET).update(base).digest('hex').slice(0,32);
  const payload = Buffer.from(base).toString('base64url');
  return `${payload}.${sig}`;
}

/* ───────── Rate limit básico (IP + email) ───────── */
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

/* ───────── Ruta principal ───────── */
router.post('/consent', async (req, res) => {
  // Log de entrada SIEMPRE (para diferenciar de registrar-consentimiento)
  const ip0 = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  const ua0 = (req.headers['user-agent'] || '').slice(0,120);
  const rawLen = Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0;
  console.log('🟢 [/marketing/consent] ENTER ip=%s ua=%s rawLen=%s', ip0, ua0, rawLen);

  // API Key
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0,180);

  // IP allowlist opcional (modo cerrado)
  if (IP_ALLOW) {
    const allow = new Set(IP_ALLOW.split(',').map(x => x.trim()).filter(Boolean));
    if (!allow.has(ip)) return res.status(403).json({ ok:false, error:'IP_FORBIDDEN' });
  }

  // HMAC:
  // Si viene del bridge interno, bastará con x-internal-bridge: 1
  const isInternalBridge = req.headers['x-internal-bridge'] === '1';
  if (!isInternalBridge && !verifyHmacFlexible(req)) {
    console.warn('⛔ BAD_HMAC en /marketing/consent ip=%s', ip);
    if (DEBUG) {
      const tsH = s(req.headers['x-lab-ts'] || req.headers['x-lb-ts']);
      const sgH = s(req.headers['x-lab-sig']|| req.headers['x-lb-sig']||'').slice(0,16)+'…';
      console.warn('⛔ BAD_HMAC detail · ts=%s sig=%s', tsH, sgH);
    }
    return res.status(401).json({ ok:false, error:'BAD_HMAC' });
  }
  if (DEBUG) console.log('🔐 HMAC check: %s', isInternalBridge ? 'via INTERNAL BRIDGE' : 'verified/exempt');

  const tsISO = nowISO();

  try {
    // Parsing básico
    const email  = s(req.body?.email).toLowerCase();
    const nombre = s(req.body?.nombre);

    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'EMAIL_REQUIRED' });

    if (DEBUG) {
      const keys = Object.keys(req.body || {});
      console.log('🧾 Body keys:', keys);
      console.log('🧾 Raw sha256:', req.rawBody ? sha256HexBuf(req.rawBody) : '(no-raw)');
    }

    console.log(`🟢 [/marketing/consent] email=${email} formId=${s(req.body?.formularioId)} ip=${ip}`);

    // Rate limit (IP+email)
    if (!checkRateLimit(ip || '0.0.0.0', email)) {
      try { await alertAdmin({ area:'newsletter_rate_limit', email, err: new Error('RATE_LIMIT'), meta:{ ip } }); } catch {}
      return res.status(429).json({ ok:false, error:'RATE_LIMIT' });
    }

    // Materias (OBLIGATORIO any=true)
    const { obj: materias, any } = normalizeMaterias(req.body?.materias, req.body || {});
    if (!any) {
      if (DEBUG) console.warn('⛔ MATERIAS_REQUIRED para %s (body puede no traer materias)', email);
      return res.status(400).json({ ok:false, error:'MATERIAS_REQUIRED' });
    }
    if (DEBUG) console.log('📚 Materias:', materiasToList(materias));

    // Consentimiento marketing (OBLIGATORIO)
    const consent_marketing = toBool(req.body?.consent_marketing, false);
    if (!consent_marketing) {
      if (DEBUG) console.warn('⛔ CONSENT_MARKETING_REQUIRED para %s', email);
      return res.status(400).json({ ok:false, error:'CONSENT_MARKETING_REQUIRED' });
    }

    const consent_comercial = toBool(req.body?.consent_comercial, false);

    // ConsentData newsletter (acepta alias: consentNewsletter)
    let consentData = {};
    try {
      const cdRaw = (req.body?.consentData !== undefined)
        ? req.body.consentData
        : req.body?.consentNewsletter;
      if (typeof cdRaw === 'string') consentData = JSON.parse(cdRaw);
      else if (typeof cdRaw === 'object') consentData = (cdRaw || {});
    } catch { consentData = {}; }

    const consentUrl     = s(consentData.consentUrl, 'https://www.laboroteca.es/consentimiento-newsletter/');
    const consentVersion = s(consentData.consentVersion, 'v1.0');
    let consentTextHash  = '';

    // Consentimiento comercial (opcional) (alias: consentPublicidad)
    let consentDataComercial = {};
    try {
      const cdcRaw = (req.body?.consentDataComercial !== undefined)
        ? req.body.consentDataComercial
        : req.body?.consentPublicidad;
      if (typeof cdcRaw === 'string') consentDataComercial = JSON.parse(cdcRaw);
      else if (typeof cdcRaw === 'object') consentDataComercial = (cdcRaw || {});
    } catch { consentDataComercial = {}; }

    const comercialUrl     = s(consentDataComercial.consentUrl);
    const comercialVersion = s(consentDataComercial.consentVersion);
    let comercialTextHash  = '';

    const sourceForm   = s(req.body?.sourceForm, 'preferencias_marketing');
    const formularioId = s(req.body?.formularioId, '45');
    const userAgent    = ua;
    const ipAddr       = ip;

    // Snapshots GCS (opcional)
    let snapshotIndividualPath = '';
    let snapshotGeneralPath = '';
    let snapshotComercialIndividualPath = '';
    let snapshotComercialGeneralPath = '';

    try {
      if (!BUCKET_NAME) {
        if (DEBUG) console.log('ℹ️ BUCKET no configurado, se omite snapshot');
      } else {
        // Newsletter
        const rawHtml  = await fetchHtml(consentUrl);
        consentTextHash = `sha256:${sha256HexBuf(rawHtml)}`;

        const htmlBuf = buildSnapshotHtml({
          rawHtmlBuffer: rawHtml,
          title: `Consentimiento Newsletter ${consentVersion}`,
          acceptedAtISO: tsISO, email, ip: ipAddr, userAgent,
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

        const individualId = sha256Hex(`${email}.${tsISO}.${Math.random()}`);
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

        // Comercial (si hay URL+versión)
        if (comercialUrl && comercialVersion) {
          const rawHtmlC = await fetchHtml(comercialUrl);
          comercialTextHash = `sha256:${sha256HexBuf(rawHtmlC)}`;

          const htmlBufC = buildSnapshotHtml({
            rawHtmlBuffer: rawHtmlC,
            title: `Consentimiento Comercial ${comercialVersion}`,
            acceptedAtISO: tsISO, email, ip: ipAddr, userAgent,
            extra: { comercialVersion, sourceForm, formularioId }
          });

          const generalPathC = `consents/comercial/${comercialVersion}.html`;
          await uploadHtmlToGCS({
            path: generalPathC,
            htmlBuffer: htmlBufC,
            metadata: { kind:'comercial-general', version: comercialVersion },
            skipIfExists: true
          });
          snapshotComercialGeneralPath = generalPathC;

          const individualIdC = sha256Hex(`${email}.${tsISO}.${Math.random()}`);
          const indivPathC = `consents/comercial/${comercialVersion}/${individualIdC}.html`;
          await uploadHtmlToGCS({
            path: indivPathC,
            htmlBuffer: htmlBufC,
            metadata: {
              kind:'comercial',
              email, comercialVersion, sourceForm, formularioId, ip: ipAddr, userAgent
            }
          });
          snapshotComercialIndividualPath = indivPathC;
        }
      }
    } catch (e) {
      console.warn('Snapshot error:', e?.message || e);
      try { await alertAdmin({ area:'newsletter_snapshot_error', email, err: e, meta:{ consentUrl } }); } catch {}
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
          comercialVersion,
          comercialUrl,
          comercialTextHash,
          sourceForm,
          formularioId,
          lastIp: ipAddr,
          lastUA: userAgent,
          updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
          createdAt
        }, { merge: true });
      });
      console.log('🔥 Firestore upsert OK → marketingConsents/%s', email);
    } catch (e) {
      console.error('Firestore set error:', e?.message || e);
      try { await alertAdmin({ area:'newsletter_firestore_error', email, err: e, meta:{} }); } catch {}
      return res.status(500).json({ ok:false, error:'FIRESTORE_WRITE_FAILED' });
    }

    // Aviso de éxito
    try { await alertAdmin({ area:'newsletter_alta_ok', email, err:null, meta:{ materias: materiasToList(materias) } }); } catch {}

    // Sheets: upsert fila A–E (no bloqueante)
    const comercialYES = consent_comercial ? 'SÍ' : 'NO';
    const materiasStr  = materiasToString(materias);
    upsertConsentRow({ nombre, email, comercialYES, materiasStr, fechaAltaISO: tsISO })
      .then((r) => { if (DEBUG) console.log('📊 Sheets upsert OK →', r); })
      .catch(async (e) => {
        console.warn('Sheets upsert warn:', e?.message || e);
        try { await alertAdmin({ area:'newsletter_sheets_warn', email, err: e, meta:{} }); } catch {}
      });

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
        await sendSMTP2GO({ to: email, subject, html: bodyTop + legal });
        if (DEBUG) console.log('📧 Welcome email OK → %s', email);
      } catch (e) {
        console.warn('Welcome email failed:', e?.message || e);
        try { await alertAdmin({ area:'newsletter_welcome_fail', email, err: e, meta:{} }); } catch {}
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
      snapshotIndividualPath,
      comercialVersion,
      snapshotComercialGeneralPath,
      snapshotComercialIndividualPath
    });

  } catch (err) {
    console.error('marketing/consent error:', err?.message || err);
    try { await alertAdmin({ area:'newsletter_consent_unexpected', email: s(req.body?.email).toLowerCase(), err, meta:{} }); } catch {}
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;

/* Campos esperados (Fluent Forms):
  • email           (obligatorio)
  • nombre
  • materias (array de textos o {derechos,cotizaciones,desempleo,bajas_ip,jubilacion,ahorro_privado,otras_prestaciones})
    (también acepta fallback desde checkboxes[])
  • consent_marketing (obligatorio)
  • consent_comercial (opcional)
  • consentData (JSON) → { consentUrl, consentVersion }
  • consentDataComercial (JSON) → { consentUrl, consentVersion } (opcional)
  • sourceForm, formularioId (opcionales)
*/
