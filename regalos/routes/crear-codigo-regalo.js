// 📂 regalos/routes/crear-codigo-regalo.js
const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const router = express.Router();

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
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i - 1);
      await new Promise(r => setTimeout(r, wait));
    }
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
  } catch { /* si no hay reglas, no pasa nada */ }

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
 * 📌 POST /crear-codigo-regalo
 */
router.post('/crear-codigo-regalo', async (req, res) => {
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
