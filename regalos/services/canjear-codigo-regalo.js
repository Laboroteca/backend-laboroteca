'use strict';

/**
 * Servicio: canjear-codigo-regalo
 * Ruta que debe invocarlo: /regalos/canjear-codigo
 * - Logs incondicionales con reqId para correlación
 * - Traza completa: entradas, normalizaciones, FS/Sheets, decisiones, errores y stacks
 */

const crypto = require('crypto');
const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet   = require('./registrarCanjeEnSheet');
const { activarMembresiaEnMemberPress } = require('./memberpress');
const { enviarEmailCanjeLibro } = require('./enviarEmailCanjeLibro');

// === Google Sheets (IDs/Pestañas) ===
const SHEET_ID_REGALOS   = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS (registro de canjes)
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL   = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos (control)
const SHEET_NAME_CONTROL = 'CODIGOS REGALO';

// === Utils de logging ========================================================
function rid() {
  const a = crypto.randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
  const b = Date.now().toString(16).slice(-4).toUpperCase();
  return `${a}-${b}`;
}
function L(reqId, msg, meta) {
  try {
    if (meta !== undefined) console.log(`[CANJEAR ${reqId}] ${msg} :: ${JSON.stringify(meta)}`);
    else console.log(`[CANJEAR ${reqId}] ${msg}`);
  } catch {
    console.log(`[CANJEAR ${reqId}] ${msg}`);
  }
}
function W(reqId, msg, meta) {
  try {
    if (meta !== undefined) console.warn(`[CANJEAR ${reqId}] WARN ${msg} :: ${JSON.stringify(meta)}`);
    else console.warn(`[CANJEAR ${reqId}] WARN ${msg}`);
  } catch {
    console.warn(`[CANJEAR ${reqId}] WARN ${msg}`);
  }
}
function E(reqId, msg, err) {
  const meta = { message: err?.message || String(err), stack: err?.stack || undefined };
  try {
    console.error(`[CANJEAR ${reqId}] ERROR ${msg} :: ${JSON.stringify(meta)}`);
  } catch {
    console.error(`[CANJEAR ${reqId}] ERROR ${msg}:`, err);
  }
}

// Helper reintentos (backoff exponencial) con logs
async function withRetries(reqId, label, fn, { tries = 5, baseMs = 120 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const wait = i === 1 ? 0 : baseMs * Math.pow(2, i - 1);
    if (i > 1) L(reqId, `Reintento ${label}`, { intento: i, esperaMs: wait });
    try {
      const r = await fn(i);
      L(reqId, `Exito ${label}`, { intento: i });
      return r;
    } catch (e) {
      lastErr = e;
      E(reqId, `Fallo en ${label} (intento ${i})`, e);
      if (i < tries) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// === Util: cliente de Sheets con auth ya hecha (log) ===
async function getSheets(reqId) {
  L(reqId, 'Inicializando Google Sheets');
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  L(reqId, 'Google Sheets listo');
  return sheets;
}

// === Util: buscar fila por código (columna C) en rango A:E, con log ===
async function findRowByCode(reqId, { sheets, spreadsheetId, range = 'A:E', codigo }) {
  L(reqId, 'Buscando codigo en hoja', { spreadsheetId, range, codigo });
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const filas = read.data.values || [];
  L(reqId, 'Hoja cargada', { filas: filas.length });
  for (let i = 1; i < filas.length; i++) {
    const c = String(filas[i]?.[2] || '').trim().toUpperCase();
    if (c === codigo) {
      const found = { row1: i + 1, row0: i };
      L(reqId, 'Codigo localizado en hoja', found);
      return found; // 1-based y 0-based
    }
  }
  W(reqId, 'Codigo NO localizado en hoja');
  return null;
}

// === DEBUG/CONFIG LOGS (no exponen secretos) ===
console.log('[CANJEAR-SVC] Config:',
  'MP_KEY?', !!process.env.MEMBERPRESS_KEY,
  'SHEETS_AUTH?', !!process.env.GCP_CREDENTIALS_BASE64
);

// ============================================================================

module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo
}) {
  const reqId = rid();
  const t0 = Date.now();

  // Normaliza entrada
  const codigo           = String(codigo_regalo || '').trim().toUpperCase();
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const libroNormalizado = String(libro_elegido || '').trim();
  const timestamp        = dayjs().format('YYYY-MM-DD HH:mm:ss');

  L(reqId, 'START datos recibidos (normalizados)', {
    nombre,
    apellidos,
    email: emailNormalizado,
    libro_elegido: libroNormalizado,
    codigo_regalo: codigo,
    timestamp
  });

  if (!nombre || !emailNormalizado || !libroNormalizado || !codigo) {
    W(reqId, 'Faltan datos obligatorios', {
      nombreOk: !!nombre, emailOk: !!emailNormalizado, libroOk: !!libroNormalizado, codigoOk: !!codigo
    });
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo  = codigo.startsWith('REG-');
  const esEntrada = codigo.startsWith('PRE-');
  const motivo    = esRegalo ? 'REGALO' : esEntrada ? 'ENTRADA' : 'OTRO';
  L(reqId, 'Tipo de canje', { esRegalo, esEntrada, motivo });

  if (!esRegalo && !esEntrada) {
    W(reqId, 'Prefijo desconocido', { codigo });
    throw new Error('prefijo desconocido');
  }

  // Idempotencia: docId=codigo
  const canjeRef = firestore.collection('regalos_canjeados').doc(codigo);
  const ya = await canjeRef.get();
  L(reqId, 'Comprobacion de canje previo', { docExiste: ya.exists });
  if (ya.exists) {
    W(reqId, 'Codigo ya canjeado previamente', { codigo });
    throw new Error('Este código ya ha sido utilizado.');
  }

  // === 1) Validación de origen ===
  if (esRegalo) {
    L(reqId, 'Validacion REG- en hoja de control');
    let sheets;
    try {
      sheets = await getSheets(reqId);
    } catch (e) {
      E(reqId, 'No se pudo inicializar Google Sheets para validar REG-', e);
      throw new Error('Requested entity was not found');
    }

    try {
      L(reqId, 'Descargando rango de control', { spreadsheetId: SHEET_ID_CONTROL, range: `'${SHEET_NAME_CONTROL}'!A2:E` });
      const controlRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `'${SHEET_NAME_CONTROL}'!A2:E`
      });
      const filas = controlRes.data.values || [];
      L(reqId, 'Filas recibidas de control', { total: filas.length });

      const fila = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigo);
      if (!fila) {
        W(reqId, 'REG no encontrado en hoja de control', { codigo });
        throw new Error('El código introducido no es válido.');
      }
      const emailAsignado = String(fila[1] || '').trim().toLowerCase();
      L(reqId, 'REG fila encontrada', { emailAsignado, coincide: !emailAsignado || emailAsignado === emailNormalizado });
      if (emailAsignado && emailAsignado !== emailNormalizado) {
        W(reqId, 'Mismatch email REG', { emailAsignado, emailReq: emailNormalizado });
        throw new Error('Este código regalo no corresponde con tu email.');
      }
    } catch (e) {
      E(reqId, 'Error validando REG- en hoja de control', e);
      throw new Error('Requested entity was not found');
    }

  } else if (esEntrada) {
    L(reqId, 'Validacion PRE- en Firestore');
    const docEntrada = await firestore.collection('entradasValidadas').doc(codigo).get();
    const ent = docEntrada.exists ? (docEntrada.data() || {}) : null;
    L(reqId, 'Doc entradasValidadas', { existe: docEntrada.exists, data: ent });

    if (!docEntrada.exists || ent.validado !== true) {
      W(reqId, 'PRE no validada', { existe: docEntrada.exists, validado: ent?.validado });
      throw new Error('Esta entrada no está validada y no puede canjearse.');
    }

    // Marcar en hoja del evento (visual)
    try {
      const sheets = await getSheets(reqId);
      const SHEETS_EVENTOS = {
        'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
        'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
        'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
        'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
        'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
      };

      const slugDeFS    = ent.slugEvento && SHEETS_EVENTOS[ent.slugEvento] ? ent.slugEvento : null;
      const idsARevisar = slugDeFS ? [SHEETS_EVENTOS[slugDeFS]] : Object.values(SHEETS_EVENTOS);
      L(reqId, 'Hojas de eventos a revisar', { slugDeFS, total: idsARevisar.length });

      let actualizado = false;
      for (const spreadsheetId of idsARevisar) {
        try {
          L(reqId, 'Revisando hoja evento', { spreadsheetId });
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const sheetIdNum = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
          L(reqId, 'sheetId (pestaña 0)', { sheetIdNum });

          const found = await findRowByCode(reqId, { sheets, spreadsheetId, codigo });
          if (!found) continue;

          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `E${found.row1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['SÍ']] }
          });
          L(reqId, 'Escrito "SÍ" en columna E', { fila: found.row1 });

          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [{
                repeatCell: {
                  range: {
                    sheetId: sheetIdNum,
                    startRowIndex: found.row0,
                    endRowIndex: found.row0 + 1,
                    startColumnIndex: 4, // E
                    endColumnIndex: 5
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: { red: 0.90, green: 0.13, blue: 0.13 },
                      textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
                    }
                  },
                  fields: 'userEnteredFormat(backgroundColor,textFormat)'
                }
              }]
            }
          });
          L(reqId, 'Formato aplicado (E rojo/blanco negrita)', { fila: found.row1 });
          actualizado = true;
          break;
        } catch (e) {
          E(reqId, `No se pudo actualizar hoja de evento ${spreadsheetId}`, e);
        }
      }

      if (!actualizado) {
        W(reqId, 'PRE no encontrado en hojas de eventos para marcar');
      }
    } catch (e) {
      E(reqId, 'Error intentando marcar PRE en Sheets (se continúa igualmente)', e);
      // No lanzamos: canje continúa
    }
  }

  // === 2) Bloqueo en Firestore (idempotencia) ===
  L(reqId, 'Bloqueando codigo en Firestore antes de activar');
  await withRetries(reqId, 'crear doc regalos_canjeados', async (i) => {
    await canjeRef.create({
      nombre,
      apellidos,
      email: emailNormalizado,
      libro: libroNormalizado,
      motivo,
      fecha: timestamp,
      activado: false,
      _intentoCreate: i
    });
  }, { tries: 5, baseMs: 150 });
  L(reqId, 'Codigo bloqueado en Firestore');

  // === 3) Registro en "Libros GRATIS" (tolerante a fallo) ===
  try {
    const sheets = await getSheets(reqId);
    L(reqId, 'Append en "Libros GRATIS"');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID_REGALOS,
      range: `'${SHEET_NAME_REGALOS}'!A2:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          nombre,
          apellidos,
          emailNormalizado,
          timestamp,
          libroNormalizado,
          motivo,
          codigo
        ]]
      }
    });
    L(reqId, 'Registrado en "Libros GRATIS"');
  } catch (e) {
    E(reqId, 'No se pudo registrar en "Libros GRATIS"', e);
  }

  // === 4) Activar membresía en MemberPress ===
  try {
    const t = libroNormalizado.toLowerCase();
    let membershipId = null;

    if (t.includes('de cara a la jubilación')) {
      membershipId = 7994;
    } else if (t.includes('adelanta tu jubilación')) {
      membershipId = 11006;
    } else if (t.includes('jubilación anticipada') || t.includes('jubilación parcial')) {
      membershipId = 11006;
    } else {
      W(reqId, 'Libro no reconocido para membresía', { libroNormalizado });
      throw new Error(`No se reconoce el libro para activar membresía: ${libroNormalizado}`);
    }

    L(reqId, 'Activando membresía en MemberPress', { email: emailNormalizado, membershipId });
    const mpRes = await activarMembresiaEnMemberPress(emailNormalizado, membershipId);
    L(reqId, 'MemberPress activación OK', { respuesta: mpRes ?? 'sin_respuesta' });

    await canjeRef.update({ activado: true, membershipId });
    L(reqId, 'Firestore actualizado (activado=true)');

  } catch (err) {
    E(reqId, 'Error activando membresía en MemberPress (canje sigue registrado/bloqueado)', err);
  }

  // === 5) Registros auxiliares (no bloqueantes) ===
  (async () => {
    try {
      L(reqId, '(AUX) Registrar en hoja de canjes general');
      const r = await registrarCanjeEnSheet({
        nombre,
        apellidos,
        email: emailNormalizado,
        codigo,
        libro: libroNormalizado
      });
      L(reqId, '(AUX) Registrado en hoja de canjes general', { resp: r ?? 'ok' });
    } catch (e) {
      E(reqId, '(AUX) No se pudo registrar en hoja de canjes general', e);
    }
  })();

  if (esRegalo) {
    (async () => {
      try {
        L(reqId, '(AUX) Marcar REG- como canjeado en hoja de control', { codigo });
        await marcarCodigoComoCanjeado(codigo);
        L(reqId, '(AUX) REG- marcado como canjeado');
      } catch (e) {
        E(reqId, '(AUX) No se pudo marcar REG- en hoja de control', e);
      }
    })();
  }

  // === 6) Email de confirmación (no bloquea) ===
  try {
    L(reqId, 'Enviando email de confirmacion', { to: emailNormalizado, libro: libroNormalizado });
    const rEmail = await enviarEmailCanjeLibro({
      toEmail: emailNormalizado,
      nombre,
      apellidos,
      libroElegido: libroNormalizado
    });
    if (!rEmail?.ok) {
      W(reqId, 'Email de confirmacion fallo', { detalle: rEmail?.error || '(sin detalle)' });
    } else {
      L(reqId, 'Email de confirmacion enviado', { resp: rEmail });
    }
  } catch (e) {
    E(reqId, 'Excepcion enviando email de confirmacion', e);
  }

  const ms = Date.now() - t0;
  L(reqId, 'FIN canje completado', { codigo, email: emailNormalizado, motivo, ms });
  return { ok: true, reqId };
};
