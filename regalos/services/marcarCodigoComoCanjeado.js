// 📂 /regalos/services/marcarCodigoComoCanjeado.js
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Hoja de control de REG-

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO'; // Nombre de pestaña

// 🎨 Colores unificados (RGB 0–1) y texto
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 }; // "NO"
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 }; // "SÍ"
const TEXTO_BLANCO_BOLD = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

/**
 * Marca un REG- como canjeado en la hoja de control:
 * - Localiza el código en la columna C (case-insensitive)
 * - Escribe "SÍ" en la columna E de esa fila
 * - Aplica formato directo (rojo + texto blanco negrita) en E{fila}
 * - (Opcional) repone reglas condicionales en la columna E para NO/SÍ con colores unificados
 */
module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!cod) {
    console.warn('⚠️ marcarCodigoComoCanjeado: código vacío.');
    return;
  }

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // Helper: obtener sheetId por título (no asumimos índice 0)
  async function getSheetIdByTitle(spreadsheetId, title) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sh = (meta.data.sheets || []).find(s => s.properties.title === title);
    return sh ? sh.properties.sheetId : null;
  }

  try {
    // 1) Localizar fila del código leyendo la columna C completa
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!C:C`, // Columna C = códigos
    });

    const rows = read.data.values || [];
    const idx = rows.findIndex(r => (r[0] || '').toString().trim().toUpperCase() === cod);
    if (idx < 0) {
      console.warn(`⚠️ Código no encontrado en control: ${cod}`);
      return;
    }
    const rowNumber = idx + 1; // 1-based

    // 2) Escribir "SÍ" en columna E de esa fila (usado)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] },
    });

    // 3) Formato directo en E{fila}: rojo + texto blanco negrita (unificado)
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

      // 4) (Opcional) Reponer reglas condicionales en toda la columna E con colores unificados
      //    Eliminamos reglas existentes de forma defensiva (si no hay, no rompe)
      try {
        // Intento de borrar varias reglas desde el índice 0 (si existen)
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
      } catch { /* sin drama si no hay reglas */ }

      // Añadir reglas: NO → verde, SÍ → rojo (ambas con texto blanco y negrita)
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CONTROL,
        requestBody: {
          requests: [
            {
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }], // E completa
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
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }], // E completa
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

    console.log(`✅ REG ${cod} marcado como canjeado (E${rowNumber} = "SÍ" con formato unificado)`);
  } catch (err) {
    console.error(`❌ Error al marcar ${cod} como canjeado:`, err?.message || err);
    throw err;
  }
};
