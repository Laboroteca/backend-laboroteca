// 📂 regalos/services/canjear-codigo-regalo.js
'use strict';

/**
 * Servicio: canjear-codigo-regalo
 * 🔗 RUTAS QUE LO INVOCAN (desde Express):
 *   - CANÓNICA:     POST /regalos/canjear-codigo
 *   - ALIAS:        POST /regalos/canjear-codigo-regalo
 *
 * Asume que el router ya:
 *   - verificó HMAC
 *   - normalizó/validó campos básicos
 *   - mapeó variantes (libro/libro_elegido, codigo/codigo_regalo)
 *
 * Aquí:
 *   - LOGS INCONDICIONALES en cada paso (inicio, normalización, FS/Sheets, decisiones, errores y stacks)
 *   - Reintentos con backoff en operaciones críticas
 *   - Idempotencia por Firestore (docId = código)
 */

const crypto = require('crypto');
const dayjs = require('dayjs');
const { google } = require('googleapis');

// Firebase Admin inicializado en ../../firebase
const admin = require('../../firebase');
const firestore = admin.firestore();

// Sheets auth
const { auth } = require('../../entradas/google/sheetsAuth');

// Utilidades del dominio
const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet   = require('./registrarCanjeEnSheet');
const { activarMembresiaEnMemberPress } = require('./memberpress');
const { enviarEmailCanjeLibro } = require('./enviarEmailCanjeLibro');

// === Google Sheets (IDs/Pestañas) ===
const SHEET_ID_REGALOS   = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS (registro de canjes)
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL   = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos (control)
const SHEET_NAME_CONTROL = 'CODIGOS REGALO';

// === LOG HELPERS =============================================================
function rid() {
  const a = crypto.randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
  const b = Date.now().toString(16).slice(-4).toUpperCase();
  return `${a}-${b}`;
}
function L(reqId, msg, meta) {
  try { console.log(`[CANJEAR ${reqId}] ${msg}${meta!==undefined ? ' :: '+JSON.stringify(meta) : ''}`); }
  catch { console.log(`[CANJEAR ${reqId}] ${msg}`); }
}
function W(reqId, msg, meta) {
  try { console.warn(`[CANJEAR ${reqId}] WARN ${msg}${meta!==undefined ? ' :: '+JSON.stringify(meta) : ''}`); }
  catch { console.warn(`[CANJEAR ${reqId}] WARN ${msg}`); }
}
function E(reqId, msg, err) {
  const meta = { message: err?.message || String(err), stack: err?.stack || undefined };
  try { console.error(`[CANJEAR ${reqId}] ERROR ${msg} :: ${JSON.stringify(meta)}`); }
  catch { console.error(`[CANJEAR ${reqId}] ERROR ${msg}:`, err); }
}

// Reintentos con backoff exponencial
async function withRetries(reqId, label, fn, { tries = 5, baseMs = 120 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    const wait = i === 1 ? 0 : baseMs * Math.pow(2, i - 1);
    if (i > 1) L(reqId, `Reintento ${label}`, { intento: i, esperaMs: wait });
    try {
      const r = await fn(i);
      L(reqId, `Éxito ${label}`, { intento: i });
      return r;
    } catch (e) {
      lastErr = e;
      E(reqId, `Fallo en ${label} (intento ${i})`, e);
      if (i < tries) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Sheets client con auth
async function getSheets(reqId) {
  L(reqId, 'Inicializando Google Sheets');
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  L(reqId, 'Google Sheets listo');
  return sheets;
}

// Buscar fila por código (columna C) en rango A:E
async function findRowByCode(reqId, { sheets, spreadsheetId, range = 'A:E', codigo }) {
  L(reqId, 'Buscando código en hoja', { spreadsheetId, range, codigo });
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const filas = read.data.values || [];
  L(reqId, 'Hoja cargada', { filas: filas.length });
  for (let i = 1; i < filas.length; i++) {
    const c = String(filas[i]?.[2] || '').trim().toUpperCase();
    if (c === codigo) {
      const found = { row1: i + 1, row0: i };
      L(reqId, 'Código localizado en hoja', found);
      return found; // 1-based y 0-based
    }
  }
  W(reqId, 'Código NO localizado en hoja');
  return null;
}

// Boot log (no expone secretos)
console.log('[CANJEAR-SVC BOOT] Env:', {
  MP_KEY: !!process.env.MEMBERPRESS_KEY,
  SHEETS_AUTH: !!process.env.GCP_CREDENTIALS_BASE64,
  FIRESTORE_PROJECT: admin?.app?.options?.projectId || '(desconocido)'
});

// ============================================================================

/**
 * Punto de entrada del servicio (usado por el router).
 * Acepta también `libro` y `codigo` como tolerancia.
 */
module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo,
  membershipId: membershipIdOverride,
  // tolerancias
  libro,
  codigo
}) {
  const reqId = rid();
  const t0 = Date.now();

  // Normalización de entrada (tolerando variantes)
  const codigoNorm = String(codigo_regalo || codigo || '').trim().toUpperCase();
  const emailNorm  = String(email || '').trim().toLowerCase();
  const libroNorm  = String(libro_elegido || libro || '').trim();
  const timestamp  = dayjs().format('YYYY-MM-DD HH:mm:ss');

  L(reqId, 'START datos recibidos (normalizados)', {
    nombre, apellidos, email: emailNorm, libro_elegido: libroNorm, codigo_regalo: codigoNorm, membershipIdOverride, timestamp
  });

  if (!nombre || !emailNorm || !libroNorm || !codigoNorm) {
    W(reqId, 'Faltan datos obligatorios', {
      nombreOk: !!nombre, emailOk: !!emailNorm, libroOk: !!libroNorm, codigoOk: !!codigoNorm
    });
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo  = codigoNorm.startsWith('REG-');
  const esEntrada = codigoNorm.startsWith('PRE-');
  const motivo    = esRegalo ? 'REGALO' : esEntrada ? 'ENTRADA' : 'OTRO';

  L(reqId, 'Tipo de canje', { esRegalo, esEntrada, motivo, prefijo: codigoNorm.slice(0, 4) });

  if (!esRegalo && !esEntrada) {
    W(reqId, 'Prefijo desconocido', { codigo: codigoNorm });
    throw new Error('prefijo desconocido');
  }

  // Idempotencia: docId=codigo
  const canjeRef = firestore.collection('regalos_canjeados').doc(codigoNorm);
  let ya;
  try {
    ya = await canjeRef.get();
    L(reqId, 'Comprobación de canje previo', { docExiste: ya.exists });
  } catch (e) {
    E(reqId, 'Error leyendo canje previo en Firestore', e);
    throw new Error('Error interno leyendo estado previo');
  }
  if (ya.exists) {
    W(reqId, 'Código ya canjeado previamente', { codigo: codigoNorm });
    throw new Error('Este código ya ha sido utilizado.');
  }

  // === 1) Validación de origen ===
  if (esRegalo) {
    L(reqId, 'Validación REG- en hoja de control (Sheets)');
    let sheets;
    try {
      sheets = await getSheets(reqId);
    } catch (e) {
      E(reqId, 'No se pudo inicializar Google Sheets para validar REG-', e);
      throw new Error('Requested entity was not found');
    }

    try {
      const range = `'${SHEET_NAME_CONTROL}'!A2:E`;
      L(reqId, 'Descargando rango de control', { spreadsheetId: SHEET_ID_CONTROL, range });
      const controlRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID_CONTROL, range });
      const filas = controlRes.data.values || [];
      L(reqId, 'Filas recibidas de control', { total: filas.length });

      const fila = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigoNorm);
      if (!fila) {
        W(reqId, 'REG no encontrado en hoja de control', { codigo: codigoNorm });
        throw new Error('El código introducido no es válido.');
      }
      const emailAsignado = String(fila[1] || '').trim().toLowerCase();
      L(reqId, 'REG fila encontrada', { emailAsignado, coincide: !emailAsignado || emailAsignado === emailNorm });
      if (emailAsignado && emailAsignado !== emailNorm) {
        W(reqId, 'Mismatch email REG', { emailAsignado, emailReq: emailNorm });
        throw new Error('Este código regalo no corresponde con tu email.');
      }
    } catch (e) {
      E(reqId, 'Error validando REG- en hoja de control', e);
      throw new Error('Requested entity was not found');
    }

  } else if (esEntrada) {
    L(reqId, 'Validación PRE- en Firestore');
    try {
      const docEntrada = await firestore.collection('entradasValidadas').doc(codigoNorm).get();
      const ent = docEntrada.exists ? (docEntrada.data() || {}) : null;
      L(reqId, 'Doc entradasValidadas', { existe: docEntrada.exists, data_keys: ent ? Object.keys(ent) : [] });

      if (!docEntrada.exists || ent.validado !== true) {
        W(reqId, 'PRE no validada', { existe: docEntrada.exists, validado: ent?.validado });
        throw new Error('Esta entrada no está validada y no puede canjearse.');
      }

      // Marcar visual en hoja del evento (tolerante a fallo)
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

            const found = await findRowByCode(reqId, { sheets, spreadsheetId, codigo: codigoNorm });
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
      }
    } catch (e) {
      E(reqId, 'Error validando PRE- en Firestore/Sheets', e);
      throw e;
    }
  }

  // === 2) Bloqueo en Firestore (idempotencia) ===
  L(reqId, 'Bloqueando código en Firestore antes de activar');
  await withRetries(reqId, 'crear doc regalos_canjeados', async (i) => {
    try {
      await canjeRef.create({
        nombre,
        apellidos,
        email: emailNorm,
        libro: libroNorm,
        motivo,
        fecha: timestamp,
        activado: false,
        _intentoCreate: i
      });
    } catch (e) {
      // Si falla por ALREADY_EXISTS: tratamos como canje previo
      if (e?.code === 6 || /already\s*exists/i.test(e?.message || '')) {
        W(reqId, 'Create falló por doc existente (idempotencia detectada)');
        throw new Error('Este código ya ha sido utilizado.');
      }
      throw e;
    }
  }, { tries: 5, baseMs: 150 });
  L(reqId, 'Código bloqueado en Firestore');

  // === 3) Registro en "Libros GRATIS" (tolerante a fallo) ===
  try {
    const sheets = await getSheets(reqId);
    L(reqId, 'Append en "Libros GRATIS"');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID_REGALOS,
      range: `'${SHEET_NAME_REGALOS}'!A2:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        nombre,
        apellidos,
        emailNorm,
        timestamp,
        libroNorm,
        motivo,
        codigoNorm
      ]] }
    });
    L(reqId, 'Registrado en "Libros GRATIS"');
  } catch (e) {
    E(reqId, 'No se pudo registrar en "Libros GRATIS"', e);
  }

  // === 4) Activar membresía en MemberPress ===
  try {
    const t = libroNorm.toLowerCase();
    let membershipId = null;

    if (membershipIdOverride) {
      membershipId = Number(membershipIdOverride) || null;
      L(reqId, 'Membership override recibido', { membershipId });
    } else {
      if (t.includes('de cara a la jubilación')) {
        membershipId = 7994;
      } else if (t.includes('adelanta tu jubilación')) {
        membershipId = 11006;
      } else if (t.includes('jubilación anticipada') || t.includes('jubilación parcial')) {
        membershipId = 11006;
      }
    }

    if (!membershipId) {
      W(reqId, 'Libro no reconocido para membresía', { libroNorm });
      throw new Error(`No se reconoce el libro para activar membresía: ${libroNorm}`);
    }

    L(reqId, 'Activando membresía en MemberPress', { email: emailNorm, membershipId });
    const mpRes = await activarMembresiaEnMemberPress(emailNorm, membershipId);
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
        email: emailNorm,
        codigo: codigoNorm,
        libro: libroNorm
      });
      L(reqId, '(AUX) Registrado en hoja de canjes general', { resp: r ?? 'ok' });
    } catch (e) {
      E(reqId, '(AUX) No se pudo registrar en hoja de canjes general', e);
    }
  })();

  if (esRegalo) {
    (async () => {
      try {
        L(reqId, '(AUX) Marcar REG- como canjeado en hoja de control', { codigo: codigoNorm });
        await marcarCodigoComoCanjeado(codigoNorm);
        L(reqId, '(AUX) REG- marcado como canjeado');
      } catch (e) {
        E(reqId, '(AUX) No se pudo marcar REG- en hoja de control', e);
      }
    })();
  }

  // === 6) Email de confirmación (no bloquea) ===
  try {
    L(reqId, 'Enviando email de confirmación', { to: emailNorm, libro: libroNorm });
    const rEmail = await enviarEmailCanjeLibro({
      toEmail: emailNorm,
      nombre,
      apellidos,
      libroElegido: libroNorm
    });
    if (!rEmail?.ok) {
      W(reqId, 'Email de confirmación FALLO', { detalle: rEmail?.error || '(sin detalle)' });
    } else {
      L(reqId, 'Email de confirmación ENVIADO', { resp: rEmail });
    }
  } catch (e) {
    E(reqId, 'Excepción enviando email de confirmación', e);
  }

  const ms = Date.now() - t0;
  L(reqId, 'FIN canje completado', { codigo: codigoNorm, email: emailNorm, motivo, ms });
  return { ok: true, reqId };
};
