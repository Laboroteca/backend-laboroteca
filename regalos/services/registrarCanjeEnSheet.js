// 📂 Ruta: /regalos/services/registrarCanjeEnSheet.js

const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const { auth } = require('../../entradas/google/sheetsAuth'); // ✅ Auth centralizado
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// 📊 ID y nombre de hoja (env override) — corrige ID y permite configurar por entorno
const SHEET_ID_CANJES   = process.env.SHEET_ID_CANJES
  || '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // ← corregido: "...83xj1..." (antes "83Xzj1")
const SHEET_NAME_CANJES = process.env.SHEET_NAME_CANJES || 'Hoja 1';

// 🛡️ Utilidades RGPD
const redactEmail = (e) => {
  const s = String(e || '').toLowerCase();
  if (!s.includes('@')) return s ? '***' : '';
  const [u, d] = s.split('@');
  return `${u.slice(0, 2)}***@***${d.slice(-3)}`;
};
const a1 = (tab, range) => {
  const t = String(tab || '').trim().replace(/'/g, "''");
  return /[^A-Za-z0-9_]/.test(t) ? `'${t}'!${range}` : `${t}!${range}`;
};

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

    console.log(`📤 Registrando canje en Sheet "${SHEET_NAME_CANJES}" → ${redactEmail(mail)} (${origen})`);

    await withRetries(() => sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID_CANJES,
      range: a1(SHEET_NAME_CANJES, 'A2:G'),
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ ts, nom, ape, mail, libroN, cod, origen ]]
      }
    }));

    console.log(`📄 Canje registrado: ${cod} (${origen}) → ${redactEmail(mail)}`);
  } catch (err) {
    console.error(`❌ Error registrando canje en Sheet "${SHEET_NAME_CANJES}":`, err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.registrarCanjeEnSheet.error',
        err,
        meta: { codigo: cod, email: mail, origen, sheetName: SHEET_NAME_CANJES }
      });
    } catch (_) {}
  }
};
