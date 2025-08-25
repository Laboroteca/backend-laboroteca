// services/registrarBajaClub.js
const { google } = require('googleapis');
const { alertAdminProxy: alertAdmin } = require('./utils/alertAdminProxy');

const spreadsheetId = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM'; // Resumen de bajas del Club
const RANGE_BASE = 'Hoja 1';
const RANGE_APPEND = `${RANGE_BASE}!A2`; // A..F

  function fmtES(iso) {
  const d = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const dd = parts.find(p => p.type === 'day')?.value ?? '';
  const mm = parts.find(p => p.type === 'month')?.value ?? '';
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '';
  return `${dd}/${mm}/${yyyy}`; // XX/XX/XXXX
}

const VERIF = (v) => String(v || 'PENDIENTE').toUpperCase();
const isCorrecto = (v) => /^CORRECTO/.test(String(v || '').toUpperCase());
const isPendiente = (v) => /^PENDIENTE/.test(String(v || '').toUpperCase());

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
 * Crea una fila de baja en A..F (Email, Nombre, Fecha solicitud, Motivo, Fecha efectos, Verificación)
 * Dedupe por (email + motivo + fechaEfectos). NO duplica si ya existe.
 */
async function registrarBajaClub({
  email,
  nombre = '',
  motivo = 'desconocido',    // 'voluntaria' | 'manual_fin_ciclo' | 'manual_inmediata' | 'impago' | 'eliminacion_cuenta' | ...
  fechaSolicitud,            // ISO opcional
  fechaEfectos,              // ISO opcional
  verificacion = 'PENDIENTE' // PENDIENTE|CORRECTO|FALLIDA
}) {
  if (!email || !email.includes('@')) return;
  const A = String(email).trim().toLowerCase();
  const B = (nombre || '-').trim();
  const C = fmtES(fechaSolicitud);
  const D = String(motivo).trim().toLowerCase();
  const E = fmtES(fechaEfectos || fechaSolicitud);
  const F = VERIF(verificacion);

  const fila = [A, B, C, D, E, F];

  try {
    const sheets = await getSheets();

    // Dedupe: leer A..E y comprobar existencia exacta
    try {
      const getRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${RANGE_BASE}!A2:E`,
      });
      const rows = getRes.data.values || [];
      const yaExiste = rows.some(r =>
        (r[0] || '').toLowerCase().trim() === A &&
        (r[3] || '').toLowerCase().trim() === D &&
        (r[4] || '').trim() === E
      );
      if (yaExiste) {
        console.log(`↪️ registrarBajaClub: ya existe fila para ${A} · ${D} · ${E}. No se duplica.`);
        return;
      }
    } catch (eGet) {
      console.warn('⚠️ registrarBajaClub: no se pudo comprobar duplicado, continúo:', eGet?.message || eGet);
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: RANGE_APPEND,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    });
    console.log(`📉 Baja registrada en Sheets: ${A} (${D})`);
  } catch (err) {
    console.error('❌ registrarBajaClub:', err?.message || err);

    // Silenciar alertas si es una baja diferida aún "pendiente"
    const esDiferida = ['voluntaria', 'manual_fin_ciclo'].includes(String(motivo || '').toLowerCase());
    if (!(esDiferida && VERIF(verificacion) === 'PENDIENTE')) {
      try { await alertAdmin({ area: 'bajas_sheet_append', email: A, err, meta: { spreadsheetId } }); } catch {}
    }
  }
}

/**
 * Actualiza la verificación (columna F) de la fila existente.
 * Criterio de búsqueda (estricto, sin crear):
 *   - Coincidencia por email (A) en minúsculas
 *   - Motivo en {voluntaria, manual_fin_ciclo} (pensado para fin de ciclo)
 *   - Si se pasa fechaEfectosISO, se busca por E=dd/mm/aaaa; si no, se toma la ÚLTIMA fila PENDIENTE por fecha.
 *   - Nunca crea nueva fila. En caso de no encontrar, devuelve {updated:false} y (opcional) alerta.
 */
async function actualizarVerificacionBaja({
  email,
  verificacion = 'PENDIENTE',
  fechaEfectosISO = null,
  motivo = null,                 // si quieres forzar 'voluntaria' o 'manual_fin_ciclo'
  strict = true,                 // NO crear nunca
  expectExisting = true,         // alerta si no se encuentra
}) {
  if (!email || !email.includes('@')) return { updated: false, reason: 'invalid_email' };

  const estado = String(verificacion).toUpperCase().includes('FALLIDA')
    ? 'FALLIDA ❌'
    : String(verificacion).toUpperCase().includes('CORRECTO')
      ? 'CORRECTO ✅'
      : 'PENDIENTE';

  const emailKey = email.toLowerCase().trim();
  const efectosKey = fechaEfectosISO ? fmtES(fechaEfectosISO) : null;

  try {
    const sheets = await getSheets();
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${RANGE_BASE}!A2:F`,
    });
    const values = getRes.data.values || [];

    // Localizar candidata:
    //  - mismo email
    //  - motivo permitido (o el forzado)
    //  - si hay fechaEfectosISO, E debe coincidir
    //  - preferir la última PENDIENTE; si no hay PENDIENTE, permitir actualizar la última no CORRECTA
    const motivosOK = motivo
      ? [String(motivo).toLowerCase().trim()]
      : ['voluntaria', 'manual_fin_ciclo'];

    let candidateIndex = -1;

    for (let i = values.length - 1; i >= 0; i--) {
      const r = values[i];
      const A = (r[0] || '').toLowerCase().trim(); // email
      const D = (r[3] || '').toLowerCase().trim(); // motivo
      const E = (r[4] || '').trim();               // fecha efectos dd/mm/aaaa
      const F = (r[5] || '').trim();               // verificación

      if (A !== emailKey) continue;
      if (!motivosOK.includes(D)) continue;
      if (efectosKey && E !== efectosKey) continue;

      // Primero intenta pendientes
      if (isPendiente(F)) { candidateIndex = i; break; }
      // Si no hay pendientes, acepta la última que no esté ya CORRECTA
      if (!isCorrecto(F) && candidateIndex === -1) candidateIndex = i;
    }

    if (candidateIndex === -1) {
      const reason = 'not_found';
      if (expectExisting) {
        try { await alertAdmin({ area: 'bajas_sheet_update_missing_row', email: emailKey, err: new Error('Fila no encontrada para actualizar F'), meta: { efectosKey, motivo: motivo || 'auto' } }); } catch {}
      }
      return { updated: false, reason };
    }

    const targetRange = `${RANGE_BASE}!F${candidateIndex + 2}`; // +2 por cabecera y 1-index
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: targetRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[estado]] },
    });

    console.log(`📝 Verificación actualizada en Sheets para ${emailKey} → ${estado}`);
    return { updated: true };
  } catch (err) {
    console.error('❌ actualizarVerificacionBaja:', err?.message || err);
    try { await alertAdmin({ area: 'bajas_sheet_update', email: emailKey, err, meta: { efectosKey, motivo: motivo || 'auto' } }); } catch {}
    return { updated: false, reason: 'exception' };
  }
}

module.exports = {
  registrarBajaClub,
  actualizarVerificacionBaja,
};
