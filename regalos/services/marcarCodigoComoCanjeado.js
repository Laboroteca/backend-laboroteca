// 📂 Ruta: /regalos/services/marcarCodigoComoCanjeado.js

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // 📄 Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

/**
 * Marca visualmente un código como canjeado en Google Sheets.
 * Aplica fondo rojo y texto en negrita a la celda del código.
 * 
 * @param {string} codigo - Código regalo ya validado (ej: REG-XXX)
 */
module.exports = async function marcarCodigoComoCanjeado(codigo) {
  if (!codigo) {
    console.warn('⚠️ No se recibió un código para marcar como canjeado.');
    return;
  }

  const codigoNormalizado = String(codigo).trim().toUpperCase();
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  try {
    // 1️⃣ Buscar el código en la hoja
    const lectura = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CONTROL,
      range: `${SHEET_NAME_CONTROL}!C2:C`, // Columna C = códigos
    });

    const filas = lectura.data.values || [];
    const indexFila = filas.findIndex(f => String(f[0] || '').trim().toUpperCase() === codigoNormalizado);

    if (indexFila === -1) {
      console.warn(`⚠️ No se encontró el código ${codigoNormalizado} en la hoja de control`);
      return;
    }

    // 2️⃣ Calcular la fila y rango de la celda
    const fila = indexFila + 2; // +2 porque empezamos en C2
    const sheetId = 0; // ⚠️ Si tu hoja no es la primera, cambia este valor

    // 3️⃣ Aplicar formato (fondo rojo claro + negrita)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID_CONTROL,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: fila - 1,
              endRowIndex: fila,
              startColumnIndex: 2, // columna C = índice 2
              endColumnIndex: 3,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 0.8, blue: 0.8 },
                textFormat: { bold: true },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        }],
      },
    });

    console.log(`🟥 Código ${codigoNormalizado} marcado como canjeado en la hoja de control`);
  } catch (err) {
    console.error(`❌ Error al marcar el código ${codigoNormalizado} como canjeado:`, err.message || err);
    throw err;
  }
};
