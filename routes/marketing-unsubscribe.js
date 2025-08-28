// routes/marketing-unsubscribe.js
// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe 1-clic (Newsletter) – Listo para producción
//   POST /marketing/unsubscribe   { token }    (también admite ?token=...)
//   - Verifica token HMAC (email + scope:newsletter + act:unsubscribe [+ exp])
//   - Borra marketingConsents/<email> (doc visible)
//   - Añade/merge en suppressionList (idempotente)
//   - Logea traza en consentLogs
//   - Actualiza Google Sheets (Col F = Fecha de baja)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const crypto  = require('crypto');
const admin   = require('firebase-admin');
const { google } = require('googleapis');
const rateLimit = require('express-rate-limit');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

// ====== CONFIG ======
const SHEET_ID = '1beWTOMlWjJvtmaGAVDegF2mTts16jZ_nKBrksnEg4Co';
const SHEET_RANGE = 'Consents!A:F'; 
const UNSUB_SECRET = process.env.MKT_UNSUB_SECRET || 'change_me_secret';

// ====== Firebase ======
if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

// ====== Helpers ======
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

function b64urlToBuf(str){
  const b64 = String(str).replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((str.length + 3) % 4);
  return Buffer.from(b64, 'base64');
}

function verifyToken(token){
  if (!token || typeof token !== 'string') throw new Error('TOKEN_MISSING');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('TOKEN_FORMAT');
  const [head, body, sig] = parts;

  const expected = b64url(crypto.createHmac('sha256', UNSUB_SECRET).update(`${head}.${body}`).digest());
  if (sig !== expected) throw new Error('TOKEN_BADSIG');

  let payload;
  try { payload = JSON.parse(b64urlToBuf(body).toString('utf8')); }
  catch { throw new Error('TOKEN_DECODE'); }

  if (payload.exp && (Date.now()/1000) > Number(payload.exp)) throw new Error('TOKEN_EXPIRED');
  if (payload.act !== 'unsubscribe' || payload.scope !== 'newsletter') throw new Error('TOKEN_SCOPE');

  const email = String(payload.email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('TOKEN_EMAIL');

  return { email, payload };
}

const nowISO = () => new Date().toISOString();

async function getSheets(){
  const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function setUnsubscribeDateByEmail(email, fechaIso, nombreFallback = ''){
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  const rows = res.data.values || [];

  let target = -1;
  for (let i = rows.length - 1; i >= 0; i--){
    const rowEmail = (rows[i][1] || '').toLowerCase();
    if (rowEmail === email.toLowerCase()){ target = i; break; }
  }

  if (target >= 0){
    const rowNum = target + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Consents!F${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[ fechaIso ]] }
    });
    return { updatedRow: rowNum };
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[ nombreFallback || '', email, 'NO', '—', '', fechaIso ]] }
    });
    return { appended: true };
  }
}

// ====== Rate limit (defensivo) ======
const unsubLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,              // máx 5 peticiones por IP/min
  message: { ok:false, error:'RATE_LIMIT' }
});
router.use('/marketing/unsubscribe', unsubLimiter);

// ====== Ruta principal ======
router.post('/marketing/unsubscribe', async (req, res) => {
  const when = nowISO();
  try {
    const token = String((req.body && req.body.token) || req.query.token || '');
    const { email } = verifyToken(token);
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').slice(0,180);

    // 1) marketingConsents
    const consRef = db.collection('marketingConsents').doc(email);
    const snap = await consRef.get();
    let nombre = '';
    if (snap.exists){
      nombre = (snap.data() || {}).nombre || '';
      await consRef.delete().catch(async e=>{
        await alertAdmin(`❌ Error al borrar marketingConsents de ${email}: ${e.message}`);
        throw e;
      });
    }

    // 2) suppressionList
    await db.collection('suppressionList').doc(email).set({
      email, scope: 'newsletter', reason: 'user_unsubscribe',
      createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      createdAtISO: when, ip, ua
    }, { merge: true }).catch(async e=>{
      await alertAdmin(`❌ Error al añadir suppressionList de ${email}: ${e.message}`);
      throw e;
    });

    // 3) Logs mínimos
    await db.collection('consentLogs').add({
      flow: 'newsletter', action: 'unsubscribe',
      email, ip, userAgent: ua,
      acceptedAt: admin.firestore.Timestamp.fromDate(new Date()),
      acceptedAtISO: when
    }).catch(async e=>{
      await alertAdmin(`⚠️ No se pudo registrar log de baja (${email}): ${e.message}`);
    });

    // 4) Sheets
    try { await setUnsubscribeDateByEmail(email, when, nombre); }
    catch (e) { await alertAdmin(`⚠️ Error actualizando Sheets baja ${email}: ${e.message}`); }

    return res.json({ ok: true, email, when });
  } catch (e) {
    const msg = e?.message || 'UNSUB_ERROR';
    console.error('unsubscribe error:', msg);
    await alertAdmin(`❌ Error UNSUB: ${msg}`);
    return res.status(400).json({ ok:false, error: msg });
  }
});

module.exports = router;

