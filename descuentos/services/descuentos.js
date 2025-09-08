// 📂 descuentos/services/descuentos.js
'use strict';

const crypto = require('crypto');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');
const { enviarEmailPersonalizado } = require('../../services/email');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ================== CONFIG ================== */
const SHEET_ID = process.env.SHEET_ID_DESCUENTOS || '15ruIDI8avTYm1-7ElAEWI6eX89wzkLnoFt-E9yuSLVs';
const SHEET_NAME = 'CODIGOS DESCUENTO GENERADOS';

const API_KEY = process.env.DESCUENTOS_API_KEY || '';
const HMAC_SECRET = process.env.DESCUENTOS_HMAC_SECRET || '';

const SKEW_MS = Number(process.env.DESC_SKEW_MS || 5 * 60 * 1000); // ±5min
const RATE_PER_MIN = Number(process.env.DESC_RATE_PER_MIN || 60);  // peticiones / min
const MAX_BODY = Number(process.env.DESC_MAX_BODY || 10 * 1024);   // 10 KB

/* ================== HELPERS ================== */
function maskTail(s) { return s ? `••••${String(s).slice(-4)}` : null; }

/* ========== Middleware HMAC + Rate Limit ========== */
async function verifyHmac(req, res, next) {
  try {
    // Rate limit simple por IP (ventana minuto)
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (ip) {
      const rlKey = `desc_rl_${ip}_${new Date().toISOString().slice(0,16)}`; // min resolution
      const snap = await firestore.collection('_rateLimit').doc(rlKey).get();
      if (snap.exists && (snap.data().count || 0) >= RATE_PER_MIN) {
        return res.status(429).json({ error: 'Too Many Requests' });
      }
      await firestore.collection('_rateLimit').doc(rlKey).set(
        { count: (snap.exists ? snap.data().count : 0) + 1, ts: Date.now() },
        { merge: true }
      );
    }

    // Tamaño body
    const bodyStr = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (bodyStr.length > MAX_BODY) {
      return res.status(413).json({ error: 'Payload demasiado grande' });
    }

    // Cabeceras
    const hdrKey = (req.headers['x-api-key'] || '').trim();
    const ts = String(req.headers['x-entr-ts'] || req.headers['x-e-ts'] || '');
    const sig = String(req.headers['x-entr-sig'] || req.headers['x-e-sig'] || '');

    if (hdrKey !== API_KEY) return res.status(401).json({ error: 'Unauthorized (key)' });
    if (!/^\d+$/.test(ts)) return res.status(401).json({ error: 'Unauthorized (ts)' });

    const now = Date.now();
    if (Math.abs(now - Number(ts)) > SKEW_MS) {
      return res.status(401).json({ error: 'Unauthorized (skew)' });
    }

    // Firma
    const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
    const pathname = new URL(req.originalUrl, 'http://x').pathname;
    const base = `${ts}.POST.${pathname}.${bodyHash}`;
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return res.status(401).json({ error: 'Unauthorized (sig)' });
    }

    return next();
  } catch (e) {
    console.error('❌ [verifyHmac] Error:', e?.message || e);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

/* ========== Crear código descuento ========== */
async function crearCodigoDescuento({ nombre, email, codigo, valor, otorganteEmail }) {
  const cod = String(codigo || '').trim().toUpperCase();
  const docRef = firestore.collection('codigosDescuento').doc(cod);

  // Idempotencia fuerte: si ya existe, 409
  const snap = await docRef.get();
  if (snap.exists) {
    const err = new Error('Código ya existe');
    err.code = 'ALREADY_EXISTS';
    throw err;
  }

  await docRef.set({
    nombre,
    email: String(email).toLowerCase(),
    codigo: cod,
    valor: Number(valor),
    otorgante_email: otorganteEmail || null,
    creado: new Date().toISOString(),
    usado: false
  });

  // Google Sheets (best-effort, no bloquea)
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const range = `'${SHEET_NAME}'!A2:F`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nombre, email, cod, valor, otorganteEmail || '', 'NO']]
      }
    });
  } catch (e) {
    console.warn('⚠️ [descuentos] Error registrando en Sheets:', e?.message || e);
    await alertAdmin({
      area: 'descuentos.sheets_error',
      err: e,
      meta: { codigo: cod, email }
    });
  }

  // Email (best-effort, no bloquea)
  try {
    await enviarEmailPersonalizado({
      to: email,
      subject: `Tu código descuento: ${cod}`,
      text: `Hola ${nombre},\n\nTu código descuento es ${cod} (valor ${valor}€).\n\nUn saludo,\nIgnacio`,
      html: `<p>Hola <strong>${nombre}</strong>,</p>
             <p>Tu <strong>código descuento</strong> es: <strong>${cod}</strong> (valor ${valor} €).</p>
             <p>Un saludo,<br/>Ignacio</p>`
    });
  } catch (e) {
    console.warn('⚠️ [descuentos] Error enviando email:', e?.message || e);
    await alertAdmin({
      area: 'descuentos.email_error',
      err: e,
      meta: { codigo: cod, email }
    });
  }

  console.log(`🎟️ Código DESCUENTO creado → ${cod} (${valor} €) para ${email} | otorgante: ${otorganteEmail || 'desconocido'}`);

  return { codigo: cod, valor };
}

module.exports = { verifyHmac, crearCodigoDescuento };
