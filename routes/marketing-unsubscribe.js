// routes/marketing-unsubscribe.js
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

/* ───────── UI helpers (estilos unificados) ───────── */
const SUCCESS_CSS = `
.ff-custom-success{
  text-align:center;padding:22px;font-size:20px;background-color:#d6f9dc;color:#1c7c3a;
  border:1px solid #a9e5b6;border-radius:8px;margin:20px 0;font-family:inherit
}
`;
const ERROR_CSS = `
.ff-custom-error{
  background-color:#f9d6d5;color:#7c1c18;border:1px solid #e5a9a7;padding:20px;border-radius:8px;
  font-family:inherit;text-align:center;font-size:18px;line-height:1.5;margin:0;width:100%;box-sizing:border-box
}
`;
function htmlSuccess(msg){
  return `<!doctype html><meta charset="utf-8"><style>${SUCCESS_CSS}${ERROR_CSS}</style><div class="ff-custom-success">✅ ${msg}</div>`;
}
function htmlError(msg){
  return `<!doctype html><meta charset="utf-8"><style>${SUCCESS_CSS}${ERROR_CSS}</style><div class="ff-custom-error">⚠️ ${msg}</div>`;
}
function wantsHtml(req){
  return String(req.query.html||'')==='1' || String(req.headers.accept||'').includes('text/html');
}

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

/* Formato de fecha para Sheets */
function formatFechaLocal(iso){
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: SHEET_TZ, day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false
    }).formatToParts(d);
    const v = (t) => parts.find(p => p.type === t)?.value || '';
    return `${v('day')}/${v('month')}/${v('year')} - ${v('hour')}:${v('minute')}h`;
  } catch { return iso; }
}

/* Google Sheets */
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

/* Token: acepta 2-part y 3-part */
function verifyToken(token){
  if (!token || typeof token !== 'string') throw new Error('TOKEN_MISSING');
  const parts = token.split('.');

  // 2-part actual
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

  // 3-part legacy
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

/* ───────── Rate limit ───────── */
const unsubLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
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

    // 1) Borrar consentimiento visible (si existe) + verificación + fallback
    const consRef = db.collection('marketingConsents').doc(email);
    const snap = await consRef.get();
    let nombre = '';
    if (snap.exists){
      const prev = snap.data() || {};
      nombre = String(prev.nombre || '');
      try {
        await consRef.delete();
        // verificación: si aún existe por reglas/latencia, fallback a update (hard off)
        const again = await consRef.get();
        if (again.exists) {
          await consRef.set({
            consent_marketing: false,
            consent_comercial: false,
            materias: {
              derechos:false, cotizaciones:false, desempleo:false, bajas_ip:false,
              jubilacion:false, ahorro_privado:false, otras_prestaciones:false
            },
            materiasList: [],
            updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
            updatedAtISO: whenISO
          }, { merge: true });
        }
      } catch (e) {
        try { await alertAdmin({ area:'unsubscribe_consents_delete_error', err:e, meta:{ email } }); } catch{}
        // como último recurso, marca OFF
        try {
          await consRef.set({
            consent_marketing:false, consent_comercial:false,
            materias:{
              derechos:false, cotizaciones:false, desempleo:false, bajas_ip:false,
              jubilacion:false, ahorro_privado:false, otras_prestaciones:false
            },
            materiasList: [],
            updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
            updatedAtISO: whenISO
          }, { merge: true });
        } catch(_) {}
      }
    }

    // 2) Suppression list (idempotente)
    await db.collection('suppressionList').doc(email).set({
      email, scope:'newsletter', reason:'user_unsubscribe',
      createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      createdAtISO: whenISO, ip, ua
    }, { merge:true });

    // 3) Log (best-effort)
    try {
      await db.collection('consentLogs').add({
        flow:'newsletter', action:'unsubscribe', email, ip, userAgent: ua,
        acceptedAt: admin.firestore.Timestamp.fromDate(new Date()),
        acceptedAtISO: whenISO
      });
    } catch (_) {}

    // 4) Sheets (best-effort)
    try { await setUnsubscribeDateByEmail(email, whenISO, nombre); } catch (_) {}

    // ── Respuesta
    const okMsg = 'Te hemos dado de baja correctamente de la newsletter.';
    if (wantsHtml(req)) return res.status(200).send(htmlSuccess(okMsg));
    return res.json({ ok:true, email, when: whenISO, message: okMsg });

  } catch (e){
    const code = String(e?.message || 'UNSUB_ERROR');
    const msgHuman = 'No hemos podido procesar la baja. El enlace puede haber caducado o ya fue usado.';
    console.error('unsubscribe error:', code);
    try { await alertAdmin({ area:'unsubscribe_error', err:e, meta:{} }); } catch{}

    if (wantsHtml(req)) return res.status(400).send(htmlError(msgHuman));
    return res.status(400).json({ ok:false, error: code, message: msgHuman });
  }
}

router.post('/marketing/unsubscribe', handleUnsubscribe);
router.post('/unsubscribe', handleUnsubscribe);

module.exports = router;
