// routes/marketing-unsubscribe.js
// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe 1-clic (Newsletter) — listo para producción
//
//  • ENDPOINTS:
//      POST /marketing/unsubscribe    (alias: POST /unsubscribe)
//        body: { token }   // también admite ?token=…
//  • Token compatible:
//      - Formato actual (2-part):  base64url("email.ts") + "." + hex(HMAC256(base)[:32])
//      - Formato legacy (3-part):  head.body.sig  con JSON {"email","scope":"newsletter","act":"unsubscribe", ...}
//  • Efectos (idempotentes):
//      - Borra marketingConsents/<email> si existe
//      - Añade/merge en suppressionList/<email>
//      - Inserta log mínimo en consentLogs
//      - Actualiza Google Sheets: Columna F = Fecha de baja (formato "DD/MM/YYYY - HH:MMh")
//
//  • Entorno:
//      - MKT_UNSUB_SECRET
//      - MKT_SHEET_ID
//      - MKT_SHEET_TAB (por defecto "Consents")
//      - MKT_SHEET_TZ  (por defecto "Europe/Madrid")
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express  = require('express');
const crypto   = require('crypto');
const admin    = require('firebase-admin');
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

/* ───────── CONFIG ───────── */
const UNSUB_SECRET = String(process.env.MKT_UNSUB_SECRET || 'change_me_secret').trim();

const SHEET_ID  = String(process.env.MKT_SHEET_ID || '1beWTOMlWjJvtmaGAVDegF2mTts16jZ_nKBrksnEg4Co').trim();
const SHEET_TAB = String(process.env.MKT_SHEET_TAB || 'Consents').trim();
const SHEET_TZ  = String(process.env.MKT_SHEET_TZ || 'Europe/Madrid').trim();

/* ───────── Firebase ───────── */
if (!admin.apps.length) { try { admin.initializeApp(); } catch(_){} }
const db = admin.firestore();

/* ───────── Helpers ───────── */
const nowISO = () => new Date().toISOString();
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

function b64urlEncode(buf){
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlToBuf(str){
  const s = String(str).replace(/-/g,'+').replace(/_/g,'/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s + pad, 'base64');
}

/* Formato de fecha para Sheets: "DD/MM/YYYY - HH:MMh" (zona configurable) */
function formatFechaLocal(iso){
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: SHEET_TZ,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const v = (t) => parts.find(p => p.type === t)?.value || '';
    return `${v('day')}/${v('month')}/${v('year')} - ${v('hour')}:${v('minute')}h`;
  } catch { return iso; }
}

/* Google Sheets helpers */
async function getSheetsClient(){
  const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}
function _needsQuotes(tab){ return /[^A-Za-z0-9_]/.test(String(tab||'')); }
function _a1(tab, range){
  const t = String(tab||'').trim();
  const esc = t.replace(/'/g, "''");
  return _needsQuotes(t) ? `'${esc}'!${range}` : `${esc}!${range}`;
}
async function setUnsubscribeDateByEmail(email, fechaIso, nombreFallback=''){
  const sheets = await getSheetsClient();
  const range  = _a1(SHEET_TAB, 'A:F');
  const fecha  = formatFechaLocal(fechaIso);

  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const rows = res.data.values || [];

  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i--){
    if ((rows[i][1] || '').toLowerCase() === email.toLowerCase()){ idx = i; break; }
  }

  if (idx >= 0){
    const rowNum = idx + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: _a1(SHEET_TAB, `F${rowNum}`),
      valueInputOption: 'RAW',
      requestBody: { values: [[ fecha ]] }
    });
    return { updatedRow: rowNum };
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[ nombreFallback || '', email, 'NO', '—', '', fecha ]] }
    });
    return { appended: true };
  }
}

/* Token: acepta 2-part (actual) y 3-part (legacy) */
function verifyToken(token){
  if (!token || typeof token !== 'string') throw new Error('TOKEN_MISSING');
  const parts = token.split('.');

  // 2-part actual: payload(sig base64url) + "." + hex(hmac(base)[:32])
  if (parts.length === 2){
    const [payloadB64, sigHex] = parts;
    const base = b64urlToBuf(payloadB64).toString('utf8'); // "email.ts"
    const exp  = crypto.createHmac('sha256', UNSUB_SECRET).update(base).digest('hex').slice(0,32);
    if (sigHex !== exp) throw new Error('TOKEN_BADSIG');

    const [emailRaw] = base.split('.');
    const email = String(emailRaw || '').toLowerCase().trim();
    if (!isEmail(email)) throw new Error('TOKEN_EMAIL');

    return { email, payload:{ base, fmt: '2part' } };
  }

  // 3-part legacy: head.body.sig con JSON
  if (parts.length === 3){
    const [head, body, sig] = parts;
    const exp = b64urlEncode(crypto.createHmac('sha256', UNSUB_SECRET).update(`${head}.${body}`).digest());
    if (sig !== exp) throw new Error('TOKEN_BADSIG');

    let payload;
    try { payload = JSON.parse(b64urlToBuf(body).toString('utf8')); }
    catch { throw new Error('TOKEN_DECODE'); }

    if (payload.scope !== 'newsletter' || payload.act !== 'unsubscribe') throw new Error('TOKEN_SCOPE');
    const email = String(payload.email || '').toLowerCase().trim();
    if (!isEmail(email)) throw new Error('TOKEN_EMAIL');

    return { email, payload:{ ...payload, fmt:'3part' } };
  }

  throw new Error('TOKEN_FORMAT');
}

/* ───────── Rate limit defensivo ───────── */
const unsubLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,              // 5 peticiones/IP/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok:false, error:'RATE_LIMIT' }
});
router.use(['/marketing/unsubscribe','/unsubscribe'], unsubLimiter);

/* ───────── Ruta principal ───────── */
async function handleUnsubscribe(req, res){
  const whenISO = nowISO();
  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0,180);

  try {
    const token = String((req.body && req.body.token) || req.query.token || '');
    const { email } = verifyToken(token);

    // 1) Borrar consentimiento visible (si existe)
    const consRef = db.collection('marketingConsents').doc(email);
    const snap = await consRef.get();
    let nombre = '';
    if (snap.exists){
      const prev = snap.data() || {};
      nombre = String(prev.nombre || '');
      try { await consRef.delete(); }
      catch (e) {
        try { await alertAdmin({ area:'unsubscribe_consents_delete_error', err:e, meta:{ email } }); } catch{}
        throw e;
      }
    }

    // 2) Añadir/merge suppressionList
    try {
      await db.collection('suppressionList').doc(email).set({
        email, scope:'newsletter', reason:'user_unsubscribe',
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: whenISO, ip, ua
      }, { merge:true });
    } catch (e){
      try { await alertAdmin({ area:'unsubscribe_suppression_error', err:e, meta:{ email } }); } catch{}
      throw e;
    }

    // 3) Log mínimo (best-effort)
    try {
      await db.collection('consentLogs').add({
        flow:'newsletter', action:'unsubscribe', email, ip, userAgent: ua,
        acceptedAt: admin.firestore.Timestamp.fromDate(new Date()),
        acceptedAtISO: whenISO
      });
    } catch (e){
      try { await alertAdmin({ area:'unsubscribe_log_warn', err:e, meta:{ email } }); } catch{}
    }

    // 4) Google Sheets (best-effort)
    try { await setUnsubscribeDateByEmail(email, whenISO, nombre); }
    catch (e){ try { await alertAdmin({ area:'unsubscribe_sheets_warn', err:e, meta:{ email } }); } catch{} }

    return res.json({ ok:true, email, when: whenISO });
  } catch (e){
    const msg = e?.message || 'UNSUB_ERROR';
    console.error('unsubscribe error:', msg);
    try { await alertAdmin({ area:'unsubscribe_error', err:e, meta:{} }); } catch{}
    return res.status(400).json({ ok:false, error: msg });
  }
}

router.post('/marketing/unsubscribe', handleUnsubscribe);
router.post('/unsubscribe', handleUnsubscribe);

module.exports = router;
