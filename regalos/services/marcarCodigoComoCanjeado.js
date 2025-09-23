// 📂 /regalos/services/marcarCodigoComoCanjeado.js
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO';

// 🎨 Colores intensos unificados (RGB 0–1)
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // NO
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // SÍ

// Texto para formato directo (incluye fontSize 14)
const TEXTO_BLANCO_BOLD_14 = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 14 };
const TEXTO_NEGRO_REG_14   = { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 14 };

// Texto para reglas condicionales (sin fontSize)
const TEXTO_BLANCO_BOLD_CF = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!cod) {
    console.warn('⚠️ marcarCodigoComoCanjeado: código vacío.');
    return;
  }

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // Reintentos suaves para 429/5xx
  const withRetries = async (fn, { tries = 4, baseMs = 150 } = {}) => {
    let last;
    for (let i = 1; i <= tries; i++) {
      try { return await fn(); }
      catch (e) {
        const status = Number(e?.code || e?.response?.status || 0);
        if (i === tries || !(status === 429 || (status >= 500 && status < 600))) throw e;
        await new Promise(r => setTimeout(r, baseMs * (2 ** (i - 1))));
        last = e;
      }
    }
    throw last;
  };

  async function getSheetMeta(spreadsheetId, title) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sh = (meta.data.sheets || []).find(s => s.properties.title === title);
    if (!sh) return null;
    return {
      sheetId: sh.properties.sheetId,
      rowCount: sh.properties.gridProperties?.rowCount || 1000
    };
  }

  async function resetColumnEBaseFormat(spreadsheetId, sheetId, rowCount) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: rowCount,
              startColumnIndex: 4,
              endColumnIndex: 5
            },
            cell: { userEnteredFormat: { textFormat: TEXTO_NEGRO_REG_14 } },
            fields: 'userEnteredFormat.textFormat'
          }
        }]
      }
    });
  }

  const ENSURE_CF_EACH_TIME = String(process.env.SHEET_ENSURE_CF_EACH_TIME || '0') === '1';
  async function ensureCondFormats(spreadsheetId, sheetId) {
    if (!ENSURE_CF_EACH_TIME) return; // evita rehacer CF en cada canje
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            { deleteConditionalFormatRule: { index: 0, sheetId } },
            { deleteConditionalFormatRule: { index: 0, sheetId } },
            { deleteConditionalFormatRule: { index: 0, sheetId } },
            { deleteConditionalFormatRule: { index: 0, sheetId } }
          ]
        }
      });
    } catch {}

    const rangeE = { sheetId, startColumnIndex: 4, endColumnIndex: 5 };
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { addConditionalFormatRule: { index: 0, rule: { ranges: [rangeE], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SÍ' }] }, format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_CF } } } } },
          { addConditionalFormatRule: { index: 0, rule: { ranges: [rangeE], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'sí' }] }, format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_CF } } } } },
          { addConditionalFormatRule: { index: 0, rule: { ranges: [rangeE], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SI' }] }, format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_CF } } } } },
          { addConditionalFormatRule: { index: 0, rule: { ranges: [rangeE], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'NO' }] }, format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD_CF } } } } },
          { addConditionalFormatRule: { index: 0, rule: { ranges: [rangeE], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'no' }] }, format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD_CF } } } } }
        ]
      }
    });
  }

  try {
    const read = await withRetries(() => sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!C:E`,
    }));
    const rows = read.data.values || [];
    const idx = rows.findIndex(r => (r[0] || '').toString().trim().toUpperCase() === cod);
    if (idx < 0) {
      console.warn(`⚠️ Código no encontrado en control: ${cod}`);
      try {
        await alertAdmin({
          area: 'regalos.marcarCodigoComoCanjeado.not_found',
          err: new Error('Código no encontrado en hoja de control'),
          meta: { codigo: cod, sheetId: SHEET_ID_CONTROL, sheetName: SHEET_NAME_CONTROL }
        });
      } catch (_) {}
      return;
    }
    const rowNumber = idx + 1;

    await withRetries(() => sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] },
    }));

    const meta = await getSheetMeta(SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
    if (meta?.sheetId != null) {
      // Sólo coloreo directo a la fila tocada; el “reset” masivo es opcional y costoso
      await withRetries(() => sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CONTROL,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId: meta.sheetId,
                startRowIndex: rowNumber - 1,
                endRowIndex: rowNumber,
                startColumnIndex: 4,
                endColumnIndex: 5
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: COLOR_ROJO,
                  textFormat: TEXTO_BLANCO_BOLD_14
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
          }]
        }
      }));

      // Mantén reglas condicionales sólo si lo pides explícitamente por env
      await ensureCondFormats(SHEET_ID_CONTROL, meta.sheetId);
    }

    console.log(`✅ REG ${cod} marcado como canjeado (E${rowNumber} = "SÍ" con formato unificado 14pt)`);
  } catch (err) {
    console.error(`❌ Error al marcar ${cod} como canjeado:`, err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.marcarCodigoComoCanjeado.error',
        err,
        meta: { codigo: cod, sheetId: SHEET_ID_CONTROL, sheetName: SHEET_NAME_CONTROL }
      });
    } catch (_) {}
    throw err;
  }
};
