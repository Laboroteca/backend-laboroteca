const { google } = require('googleapis');
const { auth } = require('../google/sheetsAuth');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// MAPEO entre slugEvento y el ID real del Google Sheet
const SHEETS_EVENTOS = {
  'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
};

/** Fecha y hora actual en Madrid como: 14/08/2025 - 10:13h */
function fechaCompraES(d = new Date()) {
  const fecha = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid'
  }).format(d);
  const hora = new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Madrid'
  }).format(d);
  return `${fecha} - ${hora}h`;
}

/** Devuelve cliente Sheets cacheado */
let __sheets = null;
async function getSheets(spreadsheetId) {
  if (!__sheets) {
    const authClient = await auth();
    __sheets = google.sheets({ version: 'v4', auth: authClient });
  }
  // Llamada liviana para verificar acceso si hiciera falta:
  // await __sheets.spreadsheets.get({ spreadsheetId });
  return __sheets;
}

/** Reintentos con backoff simple (resiliencia) */
async function withRetry(fn, { tries = 3, baseMs = 300, label = 'sheets_op' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === tries - 1) break;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
  throw Object.assign(lastErr || new Error(`${label}_failed`), { label });
}

/** Busca la fila (1-based) por código leyendo sólo la columna D */
async function findRowByCode({ sheets, spreadsheetId, codigo }) {
  const getRes = await withRetry(
    () => sheets.spreadsheets.values.get({ spreadsheetId, range: 'D:D' }),
    { label: 'sheets_get_D' }
  );
  const col = getRes.data.values || [];
  // col[0] es cabecera (si existe); empezar en 1
  for (let i = 1; i < col.length; i++) {
    const val = col[i]?.[0];
    if (val && String(val).trim().toUpperCase() === String(codigo).trim().toUpperCase()) {
      return i + 1; // 1-based
    }
  }
  return -1;
}

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 * A = fecha, B = descripcionProducto, C = comprador, D = código, E/F = "NO"
 */
async function guardarEntradaEnSheet({ sheetId, comprador, descripcionProducto = '', codigo, fecha = null }) {
  try {
    const fechaVenta = fecha ? fechaCompraES(new Date(fecha)) : fechaCompraES();
    const fila = [fechaVenta, descripcionProducto, comprador, codigo, 'NO', 'NO'];

    const sheets = await getSheets(sheetId);
    await withRetry(
      () => sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'A:F',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] }
      }),
      { label: 'sheets_append' }
    );

    console.log(`✅ Entrada registrada en hoja (${sheetId}) código ${codigo}`);
  } catch (err) {
    console.error(`❌ Error al guardar entrada en hoja (${sheetId}):`, err.message);
    // 🚨 Alerta al admin con datos operativos clave
    try {
      await alertAdmin({
        area: 'entradas.sheets.guardar_error',
        err,
        meta: {
          sheetId,
          comprador,               // email del comprador
          descripcionProducto,     // nombre del evento
          codigo                   // código de la entrada
        }
      });
    } catch (_) {}
    throw err;
  }
}

/**
 * VALIDAR ENTRADA (día del evento)
 * - Solo E = "SÍ". ❌ NO se toca F.
 * - Devuelve email (C) y descripcionProducto (B).
 */
async function marcarEntradaComoUsada(codigoEntrada, slugEvento) {
  try {
    const spreadsheetId = SHEETS_EVENTOS[slugEvento];
    if (!spreadsheetId) throw new Error('Slug de evento no válido.');

    let codigo = String(codigoEntrada || '').trim();
    if (codigo.startsWith('http')) {
      try {
        const url = new URL(codigoEntrada);
        codigo = url.searchParams.get('codigo') || codigoEntrada;
      } catch {}
    }

    const sheets = await getSheets(spreadsheetId);

    const row1 = await findRowByCode({ sheets, spreadsheetId, codigo });
    if (row1 === -1) return { error: 'Código no encontrado en la hoja.' };

    // Idempotencia: si ya está "SÍ" en E, no reescribir ni fallar
    const eCell = await withRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `E${row1}` }),
      { label: 'sheets_get_E' }
    );
    const already = String(eCell.data.values?.[0]?.[0] || '').toUpperCase() === 'SÍ';
    if (!already) {
      await withRetry(
        () => sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `E${row1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['SÍ']] }
        }),
        { label: 'sheets_update_E' }
      );
    }
 

    console.log(`🎟️ Entrada ${codigo} VALIDADA en fila ${row1}`);

    // obtener datos de la fila
    const getRes = await withRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `A${row1}:F${row1}` }),
      { label: 'sheets_get_row' }
    );
    const fila = getRes.data.values?.[0] || [];
    const emailComprador  = fila[2] || '';
    const descripcionProd = fila[1] || '';

    return { ok: true, emailComprador, descripcionProd, already };
  } catch (err) {
    console.error('❌ Error al marcar entrada como usada:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

/**
 * CANJEAR POR LIBRO (cuando entregas el libro):
 * - F = "SÍ". E no se toca aquí.
 */
async function marcarEntradaComoCanjeadaPorLibro(codigoEntrada, slugEvento) {
  try {
    const spreadsheetId = SHEETS_EVENTOS[slugEvento];
    if (!spreadsheetId) throw new Error('Slug de evento no válido.');

    let codigo = String(codigoEntrada || '').trim();
    if (codigo.startsWith('http')) {
      try {
        const url = new URL(codigoEntrada);
        codigo = url.searchParams.get('codigo') || codigoEntrada;
      } catch {}
    }

    const sheets = await getSheets(spreadsheetId);

    const row1 = await findRowByCode({ sheets, spreadsheetId, codigo });
    if (row1 === -1) return { error: 'Código no encontrado en la hoja.' };

    // Idempotencia: si ya está "SÍ" en F, no reescribir ni fallar
    const fCell = await withRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `F${row1}` }),
      { label: 'sheets_get_F' }
    );
    const already = String(fCell.data.values?.[0]?.[0] || '').toUpperCase() === 'SÍ';
    if (!already) {
      await withRetry(
        () => sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `F${row1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['SÍ']] }
        }),
        { label: 'sheets_update_F' }
      );
    }

    console.log(`📕 Entrada ${codigo} CANJEADA POR LIBRO en fila ${row1}`);
    return { ok: true, already };
  } catch (err) {
    console.error('❌ Error al marcar canje por libro:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

module.exports = {
  guardarEntradaEnSheet,
  marcarEntradaComoUsada,            // E = SÍ
  marcarEntradaComoCanjeadaPorLibro, // F = SÍ
  SHEETS_EVENTOS
};
