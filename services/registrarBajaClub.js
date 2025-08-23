// services/registrarBajaClub.js
const { google } = require('googleapis');
const { alertAdmin } = require('../utils/alertAdmin');

const spreadsheetId = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM';
const range = 'Hoja 1!A2';

function fmtES(iso) {
  const d = iso ? new Date(iso) : new Date();
  // Solo fecha (dd/mm/aaaa) en zona Madrid
  return d.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
}

const VERIF = v => (String(v || 'PENDIENTE').toUpperCase());

async function getSheets() {
  const b64 = process.env.GCP_CREDENTIALS_BASE64;
  if (!b64) {
    try { await alertAdmin({ area: 'bajas_sheets_config', email: '-', err: new Error('GCP_CREDENTIALS_BASE64 ausente') }); } catch {}
    throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
  }
  const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

/**
 * Registra una baja del Club en la hoja de bajas (A..F).
 * motivo ∈ {impago, voluntaria, manual_fin_ciclo, manual_inmediata, eliminacion_cuenta, desconocido}
 * verificacion ∈ {PENDIENTE, CORRECTO, FALLIDA}
 */
async function registrarBajaClub({
  email,
  nombre = '',
  motivo = 'desconocido',
  fechaSolicitud,   // ISO opcional
  fechaEfectos,     // ISO opcional
  verificacion = 'PENDIENTE',
}) {
  if (!email || !email.includes('@')) return;

  const C = fmtES(fechaSolicitud);             // Col C
  const E = fmtES(fechaEfectos || fechaSolicitud); // Col E
  const fila = [
    String(email).trim().toLowerCase(), // A Email
    (nombre || '-').trim(),             // B Nombre
    C,                                  // C Fecha solicitud
    String(motivo).trim().toLowerCase(),// D Motivo de la baja
    E,                                  // E Fecha efectos
    VERIF(verificacion),                // F Verificación (PENDIENTE|CORRECTO|FALLIDA)
  ];

  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    });
    console.log(`📉 Baja registrada: ${email} (${motivo})`);
  } catch (err) {
    console.error('❌ registrarBajaClub:', err?.message || err);

    // Silenciar alertas para bajas diferidas en estado pendiente
    const esPendiente = VERIF(verificacion) === 'PENDIENTE';
    const motivoStr = String(motivo || '').toLowerCase();
    const esDiferida = motivoStr === 'voluntaria' || motivoStr === 'manual_fin_ciclo';

    // Solo avisar al admin si NO es baja diferida pendiente
    if (!(esPendiente && esDiferida)) {
      try {
        await alertAdmin({
          area: 'bajas_sheet_append',
          email: (email || '-').toLowerCase(),
          err,
          meta: { spreadsheetId }
        });
      } catch {}
    }
  }
}

/**
 * Actualiza la verificación (columna F) en la ÚLTIMA fila cuyo email (col A) coincida.
 * Escribe exactamente: 'CORRECTO ✅' o 'FALLIDA ❌' o 'PENDIENTE'
 */
async function actualizarVerificacionBaja({ email, verificacion = 'PENDIENTE' }) {
  if (!email || !email.includes('@')) return;
  const estado = String(verificacion).toUpperCase().includes('FALLIDA')
    ? 'FALLIDA ❌'
    : String(verificacion).toUpperCase().includes('CORRECTO')
      ? 'CORRECTO ✅'
      : 'PENDIENTE';
  try {
    const sheets = await getSheets();
    // Leer A..F para localizar última coincidencia por email
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Hoja 1!A2:F',
    });
    const values = getRes.data.values || [];
    let rowIndex = -1;
    for (let i = values.length - 1; i >= 0; i--) {
      if ((values[i][0] || '').toLowerCase().trim() === email.toLowerCase().trim()) {
        rowIndex = i; break;
      }
    }
    if (rowIndex === -1) {
      // No existe fila: no rompemos el flujo, pero dejamos alerta para rastreo
      try {
        await alertAdmin({ area: 'bajas_sheet_update_missing_row', email, err: new Error('Fila no encontrada para actualizar F') });
      } catch {}
      return;
    }
    // Rango de la columna F (A2 es fila 2 => offset + 2)
    const targetRange = `Hoja 1!F${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: targetRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[estado]] },
    });
    console.log(`📝 Actualizada verificación baja (F) para ${email}: ${estado}`);
  } catch (err) {
    console.error('❌ actualizarVerificacionBaja:', err?.message || err);
    try { await alertAdmin({ area: 'bajas_sheet_update', email, err }); } catch {}
  }
}

module.exports = { registrarBajaClub, actualizarVerificacionBaja };
