// 📂 Archivo: regalos/services/canjear-codigo-regalo.js
'use strict';

const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet   = require('./registrarCanjeEnSheet');
const { activarMembresiaEnMemberPress } = require('./memberpress'); // API oficial
const { enviarEmailCanjeLibro } = require('./enviarEmailCanjeLibro');

// === Google Sheets (IDs/Pestañas) ===
const SHEET_ID_REGALOS   = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS (registro de canjes)
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL   = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos (control)
const SHEET_NAME_CONTROL = 'CODIGOS REGALO';

// === DEBUG/CONFIG LOGS (no exponen secretos) ===
console.log('[CANJEAR-SVC] ⚙️ Config:',
  'MP_KEY?', !!process.env.MEMBERPRESS_KEY,
  'SHEETS_AUTH?', !!process.env.GCP_CREDENTIALS_BASE64
);

// Helper reintentos (backoff exponencial)
async function withRetries(fn, { tries = 5, baseMs = 120 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i - 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// === Util: cliente de Sheets con auth ya hecha ===
async function getSheets() {
  const authClient = await auth();
  return google.sheets({ version: 'v4', auth: authClient });
}

// === Util: buscar fila por código (columna C) en rango A:E ===
async function findRowByCode({ sheets, spreadsheetId, range = 'A:E', codigo }) {
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const filas = read.data.values || [];
  for (let i = 1; i < filas.length; i++) {
    const c = String(filas[i]?.[2] || '').trim().toUpperCase();
    if (c === codigo) return { row1: i + 1, row0: i }; // 1-based y 0-based
  }
  return null;
}

module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo
}) {
  // 🔹 Normaliza entrada
  const codigo           = String(codigo_regalo || '').trim().toUpperCase();
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const libroNormalizado = String(libro_elegido || '').trim();
  const timestamp        = dayjs().format('YYYY-MM-DD HH:mm:ss');

  if (!nombre || !emailNormalizado || !libroNormalizado || !codigo) {
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo  = codigo.startsWith('REG-');
  const esEntrada = codigo.startsWith('PRE-');
  const motivo    = esRegalo ? 'REGALO' : esEntrada ? 'ENTRADA' : 'OTRO';

  console.log(`🧾 [CANJE START] email=${emailNormalizado} libro="${libroNormalizado}" codigo=${codigo} motivo=${motivo}`);

  if (!esRegalo && !esEntrada) {
    console.warn(`⛔ [CANJE INVALID] Prefijo desconocido para código: ${codigo}`);
    throw new Error('prefijo desconocido');
  }

  // ⛔️ Evita doble canje (idempotencia por docID=codigo)
  const canjeRef = firestore.collection('regalos_canjeados').doc(codigo);
  const ya = await canjeRef.get();
  if (ya.exists) {
    console.warn(`⛔ [CANJE BLOQUEADO] Código ya canjeado previamente: ${codigo}`);
    throw new Error('Este código ya ha sido utilizado.');
  }

  // === 1) Validación de origen ===
  if (esRegalo) {
    // REG- debe existir en la hoja de control y (si hay email asignado) coincidir
    let sheets;
    try {
      sheets = await getSheets();
    } catch (e) {
      console.warn('⚠️ [REG VALID] No se pudo inicializar Google Sheets:', e?.message || e);
      throw new Error('Requested entity was not found');
    }

    try {
      const controlRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `'${SHEET_NAME_CONTROL}'!A2:E`
      });
      const filas = controlRes.data.values || [];
      const fila  = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigo);
      if (!fila) {
        console.warn(`⛔ [REG VALID] No encontrado en hoja de control: ${codigo}`);
        throw new Error('El código introducido no es válido.');
      }
      const emailAsignado = String(fila[1] || '').trim().toLowerCase();
      if (emailAsignado && emailAsignado !== emailNormalizado) {
        console.warn(`⛔ [REG VALID] Email mismatch: hoja=${emailAsignado} vs req=${emailNormalizado}`);
        throw new Error('Este código regalo no corresponde con tu email.');
      }
    } catch (e) {
      // Mantén respuesta genérica (para tu mapError)
      console.warn('⚠️ [REG VALID] Error validando en hoja de control:', e?.message || e);
      throw new Error('Requested entity was not found');
    }

  } else if (esEntrada) {
    // PRE- debe estar previamente validada en Firestore
    const docEntrada = await firestore.collection('entradasValidadas').doc(codigo).get();
    if (!docEntrada.exists) {
      console.warn(`⛔ [PRE VALID] No existe en entradasValidadas: ${codigo}`);
      throw new Error('Esta entrada no está validada y no puede canjearse.');
    }
    const ent = docEntrada.data() || {};
    if (ent.validado !== true) {
      console.warn(`⛔ [PRE VALID] Encontrada pero validado!=true: ${codigo}`);
      throw new Error('Esta entrada no está validada y no puede canjearse.');
    }

    // Marcar en hoja del evento (visual): E="SÍ" con estilo
    try {
      const sheets = await getSheets();

      // IDs reales de hojas de eventos (ajusta si procede)
      const SHEETS_EVENTOS = {
        'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
        'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
        'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
        'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
        'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
      };

      const slugDeFS   = ent.slugEvento && SHEETS_EVENTOS[ent.slugEvento] ? ent.slugEvento : null;
      const idsARevisar = slugDeFS ? [SHEETS_EVENTOS[slugDeFS]] : Object.values(SHEETS_EVENTOS);

      let actualizado = false;
      for (const spreadsheetId of idsARevisar) {
        try {
          // Tab id de la primera pestaña
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const sheetIdNum = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;

          const found = await findRowByCode({ sheets, spreadsheetId, codigo });
          if (!found) continue;

          // E{fila} = "SÍ"
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `E${found.row1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['SÍ']] }
          });

          // Estilo: rojo + texto blanco negrita en E{fila}
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [{
                repeatCell: {
                  range: {
                    sheetId: sheetIdNum,
                    startRowIndex: found.row0,
                    endRowIndex: found.row0 + 1,
                    startColumnIndex: 4, // E (0-based)
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

          console.log(`📕 [PRE MARK] ${codigo} → E="SÍ" (rojo) en hoja ${spreadsheetId}, fila ${found.row1}`);
          actualizado = true;
          break;
        } catch (e) {
          console.warn(`⚠️ [PRE MARK] No se pudo actualizar hoja ${spreadsheetId}:`, e?.message || e);
        }
      }

      if (!actualizado) {
        console.warn(`⚠️ [PRE MARK] ${codigo} no se encontró en ninguna hoja de eventos.`);
      }
    } catch (e) {
      console.warn('⚠️ [PRE MARK] Error intentando marcar en Sheets (no bloquea):', e?.message || e);
      // No lanzamos: canje continúa
    }
  }

  // === 2) Bloqueo en Firestore (idempotencia) ===
  console.log(`🔒 [FS] Bloqueando código antes de activar: ${codigo}`);
  await withRetries(async () => {
    await canjeRef.create({
      nombre,
      apellidos,
      email: emailNormalizado,
      libro: libroNormalizado,
      motivo,
      fecha: timestamp,
      activado: false
    });
  }, { tries: 5, baseMs: 150 });
  console.log('✅ [FS] Código bloqueado');

  // === 3) Registro en "Libros GRATIS" (bloqueante pero tolerante a fallo) ===
  try {
    const sheets = await getSheets();
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
    console.log('✅ [SHEETS] Registrado en "Libros GRATIS"');
  } catch (e) {
    console.warn('⚠️ [SHEETS] No se pudo registrar en "Libros GRATIS":', e?.message || e);
  }

  // === 4) Activar membresía en MemberPress ===
  try {
    console.log(`🔐 [MP] Activando membresía para ${emailNormalizado}…`);

    let membershipId = null;
    const t = libroNormalizado.toLowerCase();

    if (t.includes('de cara a la jubilación')) {
      membershipId = 7994;
    } else if (t.includes('adelanta tu jubilación')) {
      membershipId = 11006;
    } else if (t.includes('jubilación anticipada') || t.includes('jubilación parcial')) {
      membershipId = 11006;
    } else {
      throw new Error(`No se reconoce el libro para activar membresía: ${libroNormalizado}`);
    }

    await activarMembresiaEnMemberPress(emailNormalizado, membershipId);
    console.log(`✅ [MP] Membresía activada (ID=${membershipId})`);
    await canjeRef.update({ activado: true });

  } catch (err) {
    // No aborta el canje; ya está bloqueado y registrado
    console.error('❌ [MP] Error activando membresía:', err?.message || err);
  }

  // === 5) Registros auxiliares (no bloqueantes) ===
  (async () => {
    try {
      await registrarCanjeEnSheet({
        nombre,
        apellidos,
        email: emailNormalizado,
        codigo,
        libro: libroNormalizado
      });
      console.log('✅ [AUX] Registrado en hoja de canjes general');
    } catch (e) {
      console.warn('⚠️ [AUX] No se pudo registrar en hoja de canjes general:', e?.message || e);
    }
  })();

  if (esRegalo) {
    (async () => {
      try {
        await marcarCodigoComoCanjeado(codigo);
        console.log('✅ [AUX] Marcado REG- como canjeado en hoja de control');
      } catch (e) {
        console.warn('⚠️ [AUX] No se pudo marcar en hoja de control REG-:', e?.message || e);
      }
    })();
  }

  // === 6) Email de confirmación (no bloqueante para éxito final) ===
  try {
    const rEmail = await enviarEmailCanjeLibro({
      toEmail: emailNormalizado,
      nombre,
      apellidos,
      libroElegido: libroNormalizado
    });
    if (!rEmail?.ok) {
      console.warn('⚠️ [EMAIL] Canje OK pero fallo en envío:', rEmail?.error || '(sin detalle)');
    } else {
      console.log('✅ [EMAIL] Enviado al usuario');
    }
  } catch (e) {
    console.warn('⚠️ [EMAIL] Excepción enviando email:', e?.message || e);
  }

  console.log(`✅ [CANJE FIN] ${codigo} → ${emailNormalizado} (${motivo})`);
  return { ok: true };
};
