// 📂 Ruta: /regalos/services/registrarCanjeEnSheet.js

const { google } = require('googleapis');
const dayjs = require('dayjs');
const { auth } = require('../../entradas/google/sheetsAuth'); // ✅ Auth centralizado

const SHEET_ID_CANJES = '1XTIArNAGJXBhgBAyKuRfSSsUNzDOYg0aJKkLyC0ARdo'; // ⚠️ Confirma que existe
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
  // 🧹 Normalización
  const ts     = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const cod    = String(codigo || '').trim().toUpperCase();
  const mail   = String(email || '').trim().toLowerCase();
  const nom    = String(nombre || '').trim();
  const ape    = String(apellidos || '').trim();
  const libroN = String(libro || '').trim();

  // 🔎 Validación mínima
  if (!cod || !mail) {
    throw new Error('Faltan datos para registrar el canje (codigo/email).');
  }

  let origen = 'OTRO';
  if (cod.startsWith('REG-')) origen = 'REGALO';
  else if (cod.startsWith('PRE-')) origen = 'ENTRADA';

  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID_CANJES,
      range: `${SHEET_NAME_CANJES}!A2:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        // A: Fecha | B: Nombre | C: Apellidos | D: Email | E: Libro | F: Código | G: Origen
        values: [[ ts, nom, ape, mail, libroN, cod, origen ]]
      }
    });

    console.log(`📄 Canje registrado: ${cod} (${origen}) → ${mail}`);
  } catch (err) {
    console.error('❌ Error registrando canje en Sheet:', err?.message || err);
    // No relanzamos para no romper el flujo principal de canje:
    // si prefieres que sea bloqueante, cambia por: throw err;
  }
};
