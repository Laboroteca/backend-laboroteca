// services/registrarBajaClub.js
const { google } = require('googleapis');
const { alertAdmin } = require('../utils/alertAdmin');

// ⚠️ Mantenemos estos valores tal y como los usas hoy:
const spreadsheetId = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM';
const range = 'Hoja 1!A2';

function fmtES(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}
// F (T0) sin emoji; (T1) escribiremos emoji desde la nueva función
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
 * T0 (solicitud): añade fila A..F (F='PENDIENTE')
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

  const C = fmtES(fechaSolicitud);   // Col C
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
 * T0 (helper): baja voluntaria ⇒ calcula fechaEfectos (si no viene) y escribe una sola fila con F='PENDIENTE'
 */
async function registrarBajaVoluntariaSolicitud({ email, nombre = '', fechaSolicitudISO, fechaEfectosISO }) {
  return registrarBajaClub({
    email,
    nombre,
    motivo: 'voluntaria',
    fechaSolicitud: fechaSolicitudISO,
    fechaEfectos: fechaEfectosISO,
    verificacion: 'PENDIENTE',
  });
}

/**
 * T1 (ejecución): marcar verificación (columna F) con emoji ✅/❌
 *  - estado: 'ok' | 'fail'
 *  - se localiza la fila por (email + fechaEfectos formateada)
 */
async function actualizarVerificacionBaja({ email, fechaEfectosISO, estado }) {
  if (!email || !fechaEfectosISO) return { ok: false, reason: 'missing_params' };
  const sheets = await getSheets();
  const hoja = 'Hoja 1'; // misma pestaña que usas en `range`
  const rangoLectura = `${hoja}!A:F`;
  const fechaTxt = fmtES(fechaEfectosISO);
  try {
    const get = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: rangoLectura,
    });
    const rows = get.data.values || [];
    // rows[0] es la cabecera si existe; como tu range de append es A2,
    // aquí recorremos todo y calculamos el rowNumber real cuando encontremos la coincidencia.
    let rowNumber = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const emailOk = (r[0] || '').trim().toLowerCase() === String(email).trim().toLowerCase();
      const efectosOk = (r[4] || '').trim() === fechaTxt;
      if (emailOk && efectosOk) {
        // i=0 → primera fila de datos (porque A2); índice + 2 en A1-notation
        rowNumber = i + 2;
        break;
      }
    }
    if (rowNumber < 0) {
      // Si no encuentro fila, notifico pero no rompo
      await alertAdmin({
        area: 'bajas_sheet_find_row',
        email,
        err: new Error('No se encontró fila para actualizar F (email+fechaEfectos).'),
        meta: { fechaTxt }
      }).catch(()=>{});
      return { ok: false, reason: 'row_not_found' };
    }
    const emoji = (estado === 'ok') ? '✅ CORRECTO' : '❌ FALLIDA';
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${hoja}!F${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[emoji]] },
    });
    return { ok: true };
  } catch (err) {
    await alertAdmin({ area: 'bajas_sheet_update_F', email, err, meta: { fechaTxt } }).catch(()=>{});
    return { ok: false, reason: 'update_error', err };
  }
}

module.exports = {
  registrarBajaClub,
  registrarBajaVoluntariaSolicitud,
  actualizarVerificacionBaja,
  fmtES,
};

