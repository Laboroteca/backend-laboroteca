// regalos/services/marcarCodigoComoCanjeado.js

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

/**
 * Marca visualmente un código como canjeado en Google Sheets.
 * Le aplica fondo rojo a la celda donde esté el código.
 * 
 * @param {string} codigo - Código regalo ya validado (formato REG-XXX)
 */
module.exports = async function marcarCodigoComoCanjeado(codigo) {
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const rangeLectura = `${SHEET_NAME_CONTROL}!C2:C`; // Columna C = código

  const lectura = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_CONTROL,
    range: rangeLectura,
  });

  const filas = lectura.data.values || [];
  const indexFila = filas.findIndex(f => (f[0] || '').trim().toUpperCase() === codigo.toUpperCase());

  if (indexFila === -1) {
    console.warn(`⚠️ No se encontró el código ${codigo} en la hoja de control`);
    return;
  }

  const fila = indexFila + 2; // +2 porque empieza en C2
  const rangoCelda = `${SHEET_NAME_CONTROL}!C${fila}`;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID_CONTROL,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: 0, // ⚠️ IMPORTANTE: cambia si tu hoja no es la primera
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

  console.log(`🟥 Código ${codigo} marcado como canjeado en la hoja`);
};
