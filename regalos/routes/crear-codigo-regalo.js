// 📂 regalos/routes/crear-codigo-regalo.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');
const { enviarEmailPersonalizado } = require('../../services/email'); // email al beneficiario
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const router = express.Router();

/* =======================
   Seguridad HMAC (igual que Entradas)
   Requisitos en app.js:
   app.use(express.json({ verify:(req,res,buf)=>{ req.rawBody = buf } }));
========================= */

const API_KEY       = (process.env.ENTRADAS_API_KEY || process.env.REGALOS_API_KEY || '').trim();
const HMAC_SECRET   = (process.env.ENTRADAS_HMAC_SECRET || process.env.REGALOS_HMAC_SECRET || '').trim();
const SKEW_MS       = Number(process.env.ENTRADAS_SKEW_MS || process.env.REGALOS_SKEW_MS || 5 * 60 * 1000);
const REGALOS_DEBUG = String(process.env.REGALOS_SYNC_DEBUG || '').trim() === '1';
const LEGACY_TOKEN  = (process.env.FLUENTFORM_TOKEN || '').trim();

function maskTail(s) { return s ? `••••${String(s).slice(-4)}` : null; }
function maskEmail(e='') {
  const s = String(e||''); const i = s.indexOf('@');
  if (i<=0) return s ? '***' : '';
  const u=s.slice(0,i), d=s.slice(i+1);
  const um = u.length<=2 ? (u[0]||'*') : (u.slice(0,2)+'***'+u.slice(-1));
  const dm = d.length<=3 ? '***' : ('***'+d.slice(-3));
  return `${um}@${dm}`;
}
function maskCode(c='') {
  const m = String(c||'').trim().match(/^([A-Z]{3})-([A-Z0-9]{5})$/);
  return m ? `${m[1]}-*****` : '*****';
}

async function verifyRegalosHmac(req, res, next) {
  // 0) Compat legacy: Authorization Bearer
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const ALLOW_LEGACY = String(process.env.ALLOW_LEGACY_BEARER || '0') === '1';
  const ALLOW_IPS = String(process.env.LEGACY_ALLOW_IPS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const reqIp = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  if (ALLOW_LEGACY && bearer && bearer === LEGACY_TOKEN && (!ALLOW_IPS.length || ALLOW_IPS.includes(reqIp))) {
    console.log('[REGALOS AUTH] LEGACY Bearer OK (ip=%s)', reqIp);
    return next();
  }

  if (!API_KEY || !HMAC_SECRET) {
    try {
      await alertAdmin({
        area: 'regalos.crear.hmac_config_missing',
        err: new Error('Config incompleta (API_KEY/HMAC_SECRET)'),
        meta: { hasApiKey: !!API_KEY, hasSecret: !!HMAC_SECRET }
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Config incompleta (API_KEY/HMAC_SECRET)' });
  }

  // 1) Cabeceras HMAC (acepta x-e-* y x-entr-*)
  const hdrKey = (req.headers['x-api-key'] || '').trim();
  const ts     = String(req.headers['x-e-ts'] || req.headers['x-entr-ts'] || '');
  const sig    = String(req.headers['x-e-sig'] || req.headers['x-entr-sig'] || '');

  if (hdrKey !== API_KEY) return res.status(401).json({ error: 'Unauthorized (key)' });
  if (!/^\d+$/.test(ts))  return res.status(401).json({ error: 'Unauthorized (ts)' });

  const now = Date.now();
  if (Math.abs(now - Number(ts)) > SKEW_MS) {
    return res.status(401).json({ error: 'Unauthorized (skew)' });
  }

  // 2) Cuerpo exacto y firma
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ error: 'Unsupported Media Type' });
  }
  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({ error: 'NO_RAW_BODY' });
  }
  const jsonStr = req.rawBody.toString('utf8');
  const bodyHash = crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');

  // Path solo pathname (sin query)
  const pathname = new URL(req.originalUrl, 'http://x').pathname; // → "/regalos/crear-codigo-regalo"
  const base     = `${ts}.POST.${pathname}.${bodyHash}`;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  // Logs de base (siempre)
  console.log('[REGALOS BASE NODE]', {
    ts,
    path: pathname,
    bodyHash10: bodyHash.slice(0, 10),
    base10: base.slice(0, 10),
    sig10: String(sig).slice(0, 10)
  });

  if (REGALOS_DEBUG) {
    console.log('[REGALOS DEBUG IN]', {
      path: pathname,
      ts,
      sig10: String(sig).slice(0, 10),
      exp10: expected.slice(0, 10),
      apiKeyMasked: maskTail(API_KEY),
      headerVariant: req.headers['x-e-ts'] ? 'x-e-*' : (req.headers['x-entr-ts'] ? 'x-entr-*' : 'none')
    });
  }

  // Firma debe ser SHA-256 en hex (64 chars)
  if (!/^[a-f0-9]{64}$/i.test(sig)) {
    try {
      await alertAdmin({ area: 'regalos.crear.hmac_deny', err: new Error('Unauthorized (bad-sig-format)'), meta: { path: pathname } });
    } catch(_) {}
    return res.status(401).json({ error: 'Unauthorized (sig-format)' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) {
      try {
        await alertAdmin({
          area: 'regalos.crear.hmac_deny',
          err: new Error('Unauthorized (sig)'),
          meta: {
            path: pathname,
            ts,
            sig10: String(sig).slice(0,10)
          }
        });
      } catch (_) {}
      return res.status(401).json({ error: 'Unauthorized (sig)' });
    }
  } catch {
    try {
      await alertAdmin({
        area: 'regalos.crear.hmac_error',
        err: new Error('Unauthorized (sig-len)'),
        meta: { path: pathname }
      });
    } catch (_) {}
    return res.status(401).json({ error: 'Unauthorized (sig-len)' });
  }

  console.log('[REGALOS AUTH] HMAC OK');
  return next();
}

// 🎨 Formato condicional para Google Sheets
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // "NO"
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // "SÍ"
const TEXTO_BLANCO_BOLD = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

/** 🗒️ Hoja de control */
const SHEET_ID_CONTROL   = process.env.SHEET_ID_CONTROL   || '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';
const SHEET_NAME_CONTROL = process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO';

// Reintentos exponenciales
async function withRetries(fn, { tries = 4, baseMs = 150 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i - 1))); }
  }
  throw lastErr;
}
async function ensureSheetExists(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);
  if (!titles.includes(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  }
}
async function ensureCondFormats(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === sheetTitle);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { deleteConditionalFormatRule: { index: 0, sheetId } },
          { deleteConditionalFormatRule: { index: 0, sheetId } }
        ]
      }
    });
  } catch {}
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'NO' }] },
                format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD }
              }
            }
          }
        },
        {
          addConditionalFormatRule: {
            index: 0,
            rule: {
              ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SÍ' }] },
                format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD }
              }
            }
          }
        }
      ]
    }
  });
}



/* ============================================================
 * 📌 POST /regalos/crear-codigo-regalo  (protegido por HMAC)
 * ============================================================ */
router.post('/crear-codigo-regalo', verifyRegalosHmac, async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim();
    const email  = String(req.body?.email  || '').trim().toLowerCase();
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();

    const otorganteEmail =
      String(req.body?.otorgante_email ||
             req.body?.otorganteEmail ||
             req.headers['x-user-email'] ||
             req.headers['x-wp-user-email'] ||
             '').trim().toLowerCase();

    if (!nombre || !email || !codigo) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: nombre, email y código.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido.' });
    }
    if (!/^REG-[A-Z0-9]{5}$/.test(codigo)) {
      return res.status(400).json({ ok: false, error: 'Formato inválido: REG-XXXXX' });
    }

    const docRef = firestore.collection('codigosRegalo').doc(codigo);
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(409).json({ ok: false, error: 'Este código ya ha sido registrado previamente.' });
    }

    await docRef.set({
      nombre,
      email,
      codigo,
      otorgante_email: otorganteEmail || null,
      creado: new Date().toISOString(),
      usado: false
    });

    // Google Sheets (registro)
    try {
      const authClient = await auth();
      const sheets = google.sheets({ version: 'v4', auth: authClient });
      await ensureSheetExists(sheets, SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
      await ensureCondFormats(sheets, SHEET_ID_CONTROL, SHEET_NAME_CONTROL);

      const range = `'${SHEET_NAME_CONTROL}'!A2:E`;
      console.log(`🧾 Sheets → append en "${range}"`);

      const result = await withRetries(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID_CONTROL,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[ nombre, email, codigo, otorganteEmail || '', 'NO' ]] }
        })
      );
      if (!result?.data?.updates?.updatedRows) {
        console.warn('⚠️ Sheets no reporta filas/celdas actualizadas');
      }
    } catch (sheetErr) {
      console.warn('⚠️ No se pudo registrar en Sheets:', sheetErr?.message || sheetErr);
      try {
        await alertAdmin({
          area: 'regalos.crear.sheets_error',
          err: sheetErr,
          meta: { nombre, email, codigo, otorgante_email: otorganteEmail || null, sheetId: SHEET_ID_CONTROL, sheetName: SHEET_NAME_CONTROL }
        });
      } catch (_) {}
    }

    // ✉️ Email al beneficiario (con RGPD)
    let emailedOk = true;
    try {
      const subject = `Tu código de regalo: ${codigo}`;
      const pageUrl = 'https://www.laboroteca.es/canjear-codigo-regalo/';
      const saludo = `Un atento saludo\nIgnacio Solsona\nAbogado`;

      const textoPlano =
`Estimado/a ${nombre},

Has recibido un código de regalo: ${codigo}

Puedes canjearlo por cualquiera de mis libros publicados.
Para el canje, introduce el código en el formulario de esta página:
${pageUrl}

${saludo}

`;

      const html =
        `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;">
           <p>Estimado/a ${nombre},</p>
           <p>Has recibido un código de regalo:<strong> ${codigo}</strong></p>
           <p>Puedes canjearlo por cualquiera de mis libros publicados. Para el canje, introduce el código en el formulario de esta página:</p>
           <p><a href="${pageUrl}" target="_blank" rel="noopener">${pageUrl}</a></p>
           <p style="margin-top:16px;">
             Un atento saludo<br />
             Ignacio Solsona<br />
             Abogado
           </p>           
         </div>`;


      await enviarEmailPersonalizado({ to: email, subject, text: textoPlano, html });
      console.log(`📧 Email de regalo enviado a ${maskEmail(email)} (codigo ${maskCode(codigo)})`);
    } catch (mailErr) {
      emailedOk = false;
      console.warn('⚠️ No se pudo enviar el email al beneficiario:', mailErr?.message || mailErr);
      // No bloqueamos la creación por fallo de email
      try {
        await alertAdmin({
          area: 'regalos.crear.email_error',
          err: mailErr,
          meta: { nombre, email, codigo, otorgante_email: otorganteEmail || null }
        });
      } catch (_) {}
    }

    console.log(`🎁 Código REGALO creado → ${maskCode(codigo)} para ${maskEmail(email)} | Otorgante: ${maskEmail(otorganteEmail || '') || 'desconocido'}`);
    return res.status(201).json({ ok: true, codigo, otorgante_email: otorganteEmail || null, emailed: emailedOk });
  } catch (err) {
    console.error('❌ Error en /crear-codigo-regalo:', err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.crear.exception',
        err,
        meta: {
          nombre: String(req.body?.nombre || '').trim() || null,
          email: String(req.body?.email || '').trim().toLowerCase() || null,
          codigo: String(req.body?.codigo || '').trim().toUpperCase() || null
        }
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
