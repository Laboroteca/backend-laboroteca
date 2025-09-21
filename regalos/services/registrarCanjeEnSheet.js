// 📂 Ruta: /regalos/services/registrarCanjeEnSheet.js

const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const { auth } = require('../../entradas/google/sheetsAuth'); // ✅ Auth centralizado

// 📊 ID y nombre de hoja según captura
const SHEET_ID_CANJES = '1MjxXebR3oQIyu0bYeRWo83Xzj1sBFnDcx53HvRRBiGE';
const SHEET_NAME_CANJES = 'Hoja 1';

/**
 * Registra cualquier canje (entrada o regalo) en la hoja de control de canjes.
 * El campo "origen" se deduce del prefijo del código (REG-/PRE-).
 *
 * @param {Object} params
 * @param {string} params.nombre
 * @param {string} params.apellidos
 * @param {string} params.email
 * @param {string} params.codigo
 * @param {string} params.libro
 */
module.exports = async function registrarCanjeEnSheet({
  nombre,
  apellidos,
  email,
  codigo,
  libro
}) {
  const ts     = dayjs().tz('Europe/Madrid').format('DD/MM/YYYY HH:mm[h]');
  const cod    = String(codigo || '').trim().toUpperCase();
  const mail   = String(email || '').trim().toLowerCase();
  const nom    = String(nombre || '').trim();
  const ape    = String(apellidos || '').trim();
  const libroN = String(libro || '').trim();

  if (!cod || !mail) {
    throw new Error('Faltan datos para registrar el canje (codigo/email).');
  }

  let origen = 'OTRO';
  if (cod.startsWith('REG-')) origen = 'REGALO';
  else if (cod.startsWith('PRE-')) origen = 'ENTRADA';

  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    console.log(`📤 Registrando en Google Sheet: ID=${SHEET_ID_CANJES}, Hoja="${SHEET_NAME_CANJES}"`);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID_CANJES,
      range: `${SHEET_NAME_CANJES}!A2:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ ts, nom, ape, mail, libroN, cod, origen ]]
      }
    });

    console.log(`📄 Canje registrado en hoja: ${cod} (${origen}) → ${mail}`);
  } catch (err) {
    console.error(`❌ Error registrando canje en Sheet "${SHEET_NAME_CANJES}" (ID ${SHEET_ID_CANJES}):`, err?.message || err);
  }
};
