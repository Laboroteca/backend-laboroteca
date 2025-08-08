const { google } = require('googleapis');
const dayjs = require('dayjs');
const { auth } = require('../../entradas/google/sheetsAuth'); // ✅ Usamos el auth centralizado

const SHEET_ID_CANJES = '1XTIArNAGJXBhgBAyKuRfSSsUNzDOYg0aJKkLyC0ARdo'; // ⚠️ Asegúrate de que exista
const SHEET_NAME_CANJES = 'Hoja 1';

/**
 * Registra cualquier canje (entrada o regalo) en la hoja de control de canjes.
 * El campo "origen" se calcula automáticamente a partir del prefijo del código.
 * 
 * @param {Object} params
 * @param {string} params.nombre
 * @param {string} params.apellidos
 * @param {string} params.email
 * @param {string} params.codigo
 * @param {string} params.libro
 */
module.exports = async function registrarCanjeEnSheet({ nombre, apellidos, email, codigo, libro }) {
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const codigoLimpio = (codigo || '').trim().toUpperCase();
  const emailLimpio = (email || '').trim().toLowerCase();

  let origen = 'OTRO';
  if (codigoLimpio.startsWith('REG-')) origen = 'REGALO';
  else if (codigoLimpio.startsWith('PRE-')) origen = 'ENTRADA';

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID_CANJES,
    range: `${SHEET_NAME_CANJES}!A2:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        timestamp,
        nombre,
        apellidos,
        emailLimpio,
        libro,
        codigoLimpio,
        origen,
      ]],
    },
  });

  console.log(`📄 Canje registrado en hoja: ${codigoLimpio} (${origen})`);
};
