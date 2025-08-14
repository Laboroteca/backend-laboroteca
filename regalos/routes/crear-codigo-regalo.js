// 📂 regalos/routes/crear-codigo-regalo.js
const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const router = express.Router();

/**
 * 🗒️ Hoja de control de CÓDIGOS REGALO (previos al canje)
 * 👉 Puedes sobreescribir por env:
 *    SHEET_ID_CONTROL, SHEET_NAME_CONTROL
 */
const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL ||
  'CODIGOS REGALO'; // ⚠️ Debe coincidir EXACTO con el nombre de la pestaña

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

// 🎨 Reglas de formato condicional para la columna "Usado" (E)
async function ensureCondFormats(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === sheetTitle);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }], // E
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'NO' }] },
                format: { backgroundColor: { red: 0.8, green: 0.95, blue: 0.8 } }
              }
            },
            index: 0
          }
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }], // E
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SÍ' }] },
                format: { backgroundColor: { red: 0.95, green: 0.8, blue: 0.8 } }
              }
            },
            index: 0
          }
        }
      ]
    }
  });
}

/**
 * 📌 POST /crear-codigo-regalo
 * Body: { nombre, email, codigo }  (p.ej. codigo = "REG-ABCDE")
 */
router.post('/crear-codigo-regalo', async (req, res) => {
  try {
    // 🧹 Normalización
    const nombre = String(req.body?.nombre || '').trim();
    const email  = String(req.body?.email  || '').trim().toLowerCase();
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();

    // 📋 Validaciones
    if (!nombre || !email || !codigo) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan campos obligatorios: nombre, email y código.'
      });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido.' });
    }
    if (!/^REG-[A-Z0-9]{5}$/.test(codigo)) {
      return res.status(400).json({
        ok: false,
        error: 'Formato de código inválido. Debe ser REG-XXXXX (5 letras/números).'
      });
    }

    // 🔒 Idempotencia: evitar sobrescribir un código ya registrado
    const docRef = firestore.collection('codigosRegalo').doc(codigo);
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(409).json({
        ok: false,
        error: 'Este código ya ha sido registrado previamente.'
      });
    }

    // 💾 Guardar en Firestore
    await docRef.set({
      nombre,
      email,
      codigo,
      creado: new Date().toISOString(),
      usado: false
    });

    // 📝 Registrar en Google Sheets (con reintentos, y hoja/rango seguros)
    try {
      const authClient = await auth();
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      await ensureSheetExists(sheets, SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
      await ensureCondFormats(sheets, SHEET_ID_CONTROL, SHEET_NAME_CONTROL);

      const range = `'${SHEET_NAME_CONTROL}'!A2:E`; // comillas por el espacio
      console.log(`🧾 Sheets → append en "${range}" (ID: ${SHEET_ID_CONTROL})`);

      const result = await withRetries(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID_CONTROL,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            // A: Nombre | B: Email | C: Código | D: Ignacio/Rebeca | E: Usado ("NO")
            values: [[ nombre, email, codigo, '', 'NO' ]]
          }
        })
      );

      const updates = result?.data?.updates || {};
      if (!updates.updatedRows && !updates.updatedCells) {
        console.warn('⚠️ Sheets no reporta filas/celdas actualizadas:', updates);
      }
    } catch (sheetErr) {
      console.warn('⚠️ No se pudo registrar en Sheets (control REG-):', sheetErr?.message || sheetErr);
      // No bloqueamos la creación del código por un fallo de Sheets
    }

    console.log(`🎁 Código REGALO creado → ${codigo} para ${email}`);
    return res.status(201).json({ ok: true, codigo });
  } catch (err) {
    console.error('❌ Error en /crear-codigo-regalo:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
