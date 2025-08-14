// 📂 Ruta: /regalos/services/marcarCodigoComoCanjeado.js

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL =
  process.env.SHEET_ID_CONTROL ||
  '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos

const SHEET_NAME_CONTROL =
  process.env.SHEET_NAME_CONTROL || 'CODIGOS REGALO'; // pestaña con espacio

/**
 * Marca un REG- como canjeado en la hoja de control:
 * - Localiza el código en la columna C
 * - Escribe "SÍ" en la columna E de esa fila
 * - (Opcional) aplica formato condicional si no existe
 */
module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!cod) {
    console.warn('⚠️ marcarCodigoComoCanjeado: código vacío.');
    return;
  }

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // --- helper: obtener sheetId por título (sin asumir 0) ---
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

    // 2) Escribir "SÍ" en columna E de esa fila (Usado)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `'${SHEET_NAME_CONTROL}'!E${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] },
    });

    // 3) Asegurar formato condicional en columna E (NO=verde, SÍ=rojo)
    const sheetId = await getSheetIdByTitle(SHEET_ID_CONTROL, SHEET_NAME_CONTROL);
    if (sheetId !== null) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID_CONTROL,
        requestBody: {
          requests: [
            {
              addConditionalFormatRule: {
                rule: {
                  ranges: [{ sheetId, startColumnIndex: 4, endColumnIndex: 5 }], // E
                  booleanRule: {
                    condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'NO' }] },
                    format: { backgroundColor: { red: 0.8, green: 0.95, blue: 0.8 } } // verde suave
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
                    format: { backgroundColor: { red: 0.95, green: 0.8, blue: 0.8 } } // rojo suave
                  }
                },
                index: 0
              }
            }
          ]
        }
      });
    }

    console.log(`✅ REG ${cod} marcado como canjeado (columna E = "SÍ")`);
  } catch (err) {
    console.error(`❌ Error al marcar ${cod} como canjeado:`, err?.message || err);
    throw err;
  }
};
