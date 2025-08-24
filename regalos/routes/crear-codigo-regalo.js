// 📂 regalos/routes/crear-codigo-regalo.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const router = express.Router();

/* =======================
   Seguridad HMAC (igual que Entradas)
   Requisitos:
   - Config .env / entorno:
       ENTRADAS_API_KEY        (o REGALOS_API_KEY)
       ENTRADAS_HMAC_SECRET    (o REGALOS_HMAC_SECRET)
       ENTRADAS_SKEW_MS        (opcional, por defecto ±5 min)
       FLUENTFORM_TOKEN        (opcional: fallback Bearer)
   - En app.js debes tener:
       app.use(express.json({ verify:(req,res,buf)=>{ req.rawBody = buf } }));
   - El emisor debe firmar:
       x-api-key: ENTRADAS_API_KEY
       x-e-ts:    timestamp ms
       x-e-sig:   HMAC-SHA256( ts + '.POST.' + <pathname> + '.' + sha256(body) )
     donde <pathname> aquí es: "/regalos/crear-codigo-regalo"
========================= */

const API_KEY = (process.env.ENTRADAS_API_KEY || process.env.REGALOS_API_KEY || '').trim();
const HMAC_SECRET = (process.env.ENTRADAS_HMAC_SECRET || process.env.REGALOS_HMAC_SECRET || '').trim();
const SKEW_MS = Number(process.env.ENTRADAS_SKEW_MS || process.env.REGALOS_SKEW_MS || 5 * 60 * 1000);
const REGALOS_DEBUG = String(process.env.REGALOS_SYNC_DEBUG || '').trim() === '1';

function verifyRegalosHmac(req, res, next) {
  // Fallback compat: si llega Bearer correcto, aceptar y salir
  const bearer = req.headers['authorization'];
  if (bearer && bearer === process.env.FLUENTFORM_TOKEN) {
    if (REGALOS_DEBUG) console.log('[REGALOS DEBUG] fallback Bearer OK');
    return next();
  }

  if (!API_KEY || !HMAC_SECRET) {
    return res.status(500).json({ error: 'Config incompleta (ENTRADAS/REGALOS_API_KEY / _HMAC_SECRET)' });
  }

  const hdrKey = req.headers['x-api-key'];
  const ts = req.headers['x-e-ts'];
  const sig = req.headers['x-e-sig'];

  if (hdrKey !== API_KEY) return res.status(401).json({ error: 'Unauthorized (key)' });
  if (!/^\d+$/.test(String(ts || ''))) return res.status(401).json({ error: 'Unauthorized (ts)' });

  const now = Date.now();
  if (Math.abs(now - Number(ts)) > SKEW_MS) {
    return res.status(401).json({ error: 'Unauthorized (skew)' });
  }

  const bodyStr = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');

  // Path canónico: solo pathname (sin querystring)
  const pathname = new URL(req.originalUrl, 'http://x').pathname; // → "/regalos/crear-codigo-regalo"
  const base = `${ts}.POST.${pathname}.${bodyHash}`;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  if (REGALOS_DEBUG) {
    const maskTail = s => (s ? `••••${String(s).slice(-4)}` : null);
    console.log('[REGALOS DEBUG OUT]', {
      path: pathname,
      ts,
      bodyHash10: bodyHash.slice(0, 10),
      sig10: String(sig || '').slice(0, 10),
      exp10: expected.slice(0, 10),
      apiKeyMasked: maskTail(API_KEY),
    });
  }

  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig || '')))) {
      return res.status(401).json({ error: 'Unauthorized (sig)' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized (sig-len)' });
  }

  return next();
}

// 🎨 Colores unificados (RGB 0–1) y texto
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // "NO"
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // "SÍ"
const TEXTO_BLANCO_BOLD = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

/**
 * 🗒️ Hoja de control de CÓDIGOS REGALO (previos al canje)
 */
const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO';

// Helper: reintentos exponenciales
async function withRetries(fn, { tries = 4, baseMs = 150 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i - 1))); }
  }
  throw lastErr;
}

// 🧩 Asegura que exista la pestaña indicada
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

// 🎨 Reglas condicionales unificadas para la columna E
async function ensureCondFormats(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === sheetTitle);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  // Borrar reglas previas (si hay)
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

  // Añadir "NO" → verde, "SÍ" → rojo
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

/**
 * 📌 POST /regalos/crear-codigo-regalo  (protegido por HMAC)
 */
router.post('/crear-codigo-regalo', verifyRegalosHmac, async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim();
    const email  = String(req.body?.email  || '').trim().toLowerCase();
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();

    const otorganteEmail =
      String(req.body?.otorgante_email ||
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
          requestBody: {
            values: [[ nombre, email, codigo, otorganteEmail || '', 'NO' ]]
          }
        })
      );

      if (!result?.data?.updates?.updatedRows) {
        console.warn('⚠️ Sheets no reporta filas/celdas actualizadas');
      }
    } catch (sheetErr) {
      console.warn('⚠️ No se pudo registrar en Sheets:', sheetErr?.message || sheetErr);
    }

    console.log(`🎁 Código REGALO creado → ${codigo} para ${email} | Otorgante: ${otorganteEmail || 'desconocido'}`);
    return res.status(201).json({ ok: true, codigo, otorgante_email: otorganteEmail || null });
  } catch (err) {
    console.error('❌ Error en /crear-codigo-regalo:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
