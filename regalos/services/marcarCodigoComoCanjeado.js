// 📂 /regalos/services/marcarCodigoComoCanjeado.js
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo';

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO';

// 🎨 Colores intensos (mismos que el otro sheet)
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // NO
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // SÍ
const TEXTO_BLANCO_BOLD = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!cod) {
    console.warn('⚠️ marcarCodigoComoCanjeado: código vacío.');
    return;
  }

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  async function getSheetIdByTitle(spreadsheetId, title) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sh = (meta.data.sheets || []).find(s => s.properties.title === title);
    return sh ? sh.properties.sheetId : null;
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

    // 2) Escribir "SÍ" en E{fila}
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] },
    });

    // 3) Pintar E{fila} en rojo + texto blanco negrita (formato directo)
    const sheetId = await getSheetIdByTitle(SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
    if (sheetId !== null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CONTROL,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: rowNumber - 1,
                endRowIndex: rowNumber,
                startColumnIndex: 4, // E (0-based)
                endColumnIndex: 5
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: COLOR_ROJO,
                  textFormat: TEXTO_BLANCO_BOLD
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
          }]
        }
      });

      // 4) Reglas condicionales en E completa con mismos colores (SÍ/sí/SI y NO/no)
      //    Borrado defensivo de reglas existentes
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID_CONTROL,
          requestBody: {
            requests: [
              { deleteConditionalFormatRule: { index: 0, sheetId } },
              { deleteConditionalFormatRule: { index: 0, sheetId } },
              { deleteConditionalFormatRule: { index: 0, sheetId } }
            ]
          }
        });
      } catch {}

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CONTROL,
        requestBody: {
          requests: [
            // SÍ (mayúsculas con acento)
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
            },
            // sí (minúsculas con acento)
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }],
                  booleanRule: {
                    condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'sí' }] },
                    format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD }
                  }
                }
              }
            },
            // SI (sin acento)
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }],
                  booleanRule: {
                    condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'SI' }] },
                    format: { backgroundColor: COLOR_ROJO, textFormat: TEXTO_BLANCO_BOLD }
                  }
                }
              }
            },
            // NO (mayúsculas)
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
            // no (minúsculas)
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }],
                  booleanRule: {
                    condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'no' }] },
                    format: { backgroundColor: COLOR_VERDE, textFormat: TEXTO_BLANCO_BOLD }
                  }
                }
              }
            }
          ]
        }
      });
    }

    console.log(`✅ REG ${cod} marcado como canjeado (E${rowNumber} = "SÍ" con colores unificados)`);
  } catch (err) {
    console.error(`❌ Error al marcar ${cod} como canjeado:`, err?.message || err);
    throw err;
  }
};
