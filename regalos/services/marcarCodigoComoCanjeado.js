// 📂 /regalos/services/marcarCodigoComoCanjeado.js
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO';

// 🎨 Colores intensos unificados (RGB 0–1)
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // NO
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // SÍ

// Texto usados en “estado” (10pt asegurado; reglas y formato directo usan esto)
const TEXTO_BLANCO_BOLD_10 = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true,  fontSize: 10 };
const TEXTO_NEGRO_REG_10   = { foregroundColor: { red: 0, green: 0, blue: 0 }, bold: false, fontSize: 10 };

module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!cod) {
    console.warn('⚠️ marcarCodigoComoCanjeado: código vacío.');
    return;
  }

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // Helpers
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
    // Formato base: texto negro, 10pt, sin negrita. NO tocamos background.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: 1,                 // desde fila 2 (0-based)
              endRowIndex: rowCount,            // hasta el final de la hoja
              startColumnIndex: 4,              // E
              endColumnIndex: 5
            },
            cell: { userEnteredFormat: { textFormat: TEXTO_NEGRO_REG_10 } },
            fields: 'userEnteredFormat.textFormat'
          }
        }]
      }
    });
  }

  async function ensureCondFormats(spreadsheetId, sheetId) {
    // Borra todas las reglas existentes de la pestaña de forma defensiva
    try {
      // Intentos de borrado (si no existen, no pasa nada)
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

    // Reglas: SÍ/sí/SI → ROJO + blanco 10pt | NO/no → VERDE + blanco 10pt
    const rangeE = { sheetId, startColumnIndex: 4, endColumnIndex: 5 };
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // SÍ (mayúsculas con acento)
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [rangeE],
                booleanRule: {
                  condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SÍ' }] },
                  format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_10 }
                }
              }
            }
          },
          // sí (minúsculas con acento)
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [rangeE],
                booleanRule: {
                  condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'sí' }] },
                  format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_10 }
                }
              }
            }
          },
          // SI (sin acento)
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [rangeE],
                booleanRule: {
                  condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SI' }] },
                  format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD_10 }
                }
              }
            }
          },
          // NO (mayúsculas)
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [rangeE],
                booleanRule: {
                  condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'NO' }] },
                  format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD_10 }
                }
              }
            }
          },
          // no (minúsculas)
          {
            addConditionalFormatRule: {
              index: 0,
              rule: {
                ranges: [rangeE],
                booleanRule: {
                  condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'no' }] },
                  format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD_10 }
                }
              }
            }
          }
        ]
      }
    });
  }

  try {
    // 1) Buscar fila por columna C (case-insensitive)
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!C:C`,
    });
    const rows = read.data.values || [];
    const idx = rows.findIndex(r => (r[0] || '').toString().trim().toUpperCase() === cod);
    if (idx < 0) {
      console.warn(`⚠️ Código no encontrado en control: ${cod}`);
      return;
    }
    const rowNumber = idx + 1; // 1-based

    // 2) Escribir "SÍ" normalizado en E{fila}
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] },
    });

    // 3) Asegurar formato directo en E{fila}: ROJO + blanco negrita 10pt
    const meta = await getSheetMeta(SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
    if (meta?.sheetId != null) {
      await sheets.spreadsheets.batchUpdate({
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
                  textFormat: TEXTO_BLANCO_BOLD_10
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
          }]
        }
      });

      // 4) Fijar formato base (texto negro 10pt) en toda la columna E
      await resetColumnEBaseFormat(SHEET_ID_CONTROL, meta.sheetId, meta.rowCount);

      // 5) Reinstalar reglas condicionales en E con los mismos colores/tamaño
      await ensureCondFormats(SHEET_ID_CONTROL, meta.sheetId);
    }

    console.log(`✅ REG ${cod} marcado como canjeado (E${rowNumber} = "SÍ" con formato unificado 10pt)`);
  } catch (err) {
    console.error(`❌ Error al marcar ${cod} como canjeado:`, err?.message || err);
    throw err;
  }
};
