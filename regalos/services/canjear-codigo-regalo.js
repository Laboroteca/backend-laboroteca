// 📂 Archivo: regalos/services/canjear-codigo-regalo.js
const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet = require('./registrarCanjeEnSheet');
const { activarMembresiaEnMemberPress } = require('./memberpress'); // ✅ Nuevo servicio API oficial

const SHEET_ID_REGALOS   = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS (registro de canjes)
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL   = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos (control)
const SHEET_NAME_CONTROL = 'CODIGOS REGALO';

// Helper reintentos
async function withRetries(fn, { tries = 5, baseMs = 120 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i - 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo
}) {
  // 🔹 Normaliza
  const codigo = String(codigo_regalo || '').trim().toUpperCase();
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const libroNormalizado = String(libro_elegido || '').trim();
  const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');

  if (!nombre || !emailNormalizado || !libroNormalizado || !codigo) {
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo  = codigo.startsWith('REG-');
  const esEntrada = codigo.startsWith('PRE-');
  const motivo    = esRegalo ? 'REGALO' : esEntrada ? 'ENTRADA' : 'OTRO';

  console.log(`🧾 canjearCodigoRegalo → email=${emailNormalizado} libro="${libroNormalizado}" codigo=${codigo} motivo=${motivo}`);

  // ⛔️ Si ya está canjeado, cortamos
  const canjeRef = firestore.collection('regalos_canjeados').doc(codigo);
  const ya = await canjeRef.get();
  if (ya.exists) {
    console.warn(`⛔ Código ya canjeado previamente: ${codigo}`);
    throw new Error('Este código ya ha sido utilizado.');
  }

  // 1) Validación de origen
  if (esRegalo) {
    let sheets;
    try {
      const authClient = await auth();
      sheets = google.sheets({ version: 'v4', auth: authClient });
    } catch (e) {
      console.warn('⚠️ No se pudo inicializar Google Sheets para validar REG-:', e?.message || e);
      throw new Error('Requested entity was not found');
    }

    try {
      const controlRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `'${SHEET_NAME_CONTROL}'!A2:E`
      });
      const filas = controlRes.data.values || [];
      const fila = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigo);
      if (!fila) {
        console.warn(`⛔ REG no encontrado en hoja de control: ${codigo}`);
        throw new Error('El código introducido no es válido.');
      }
      const emailAsignado = String(fila[1] || '').trim().toLowerCase();
      if (emailAsignado && emailAsignado !== emailNormalizado) {
        console.warn(`⛔ REG email mismatch: hoja=${emailAsignado} vs req=${emailNormalizado}`);
        throw new Error('Este código regalo no corresponde con tu email.');
      }
    } catch (e) {
      console.warn('⚠️ Error validando REG- en hoja de control:', e?.message || e);
      throw new Error('Requested entity was not found');
    }

    } else if (esEntrada) {
  // ✅ 1) Comprobación en Firestore: la entrada debe estar validada previamente
  const docEntrada = await firestore.collection('entradasValidadas').doc(codigo).get();
  if (!docEntrada.exists) {
    console.warn(`⛔ PRE no está validada (no existe en entradasValidadas): ${codigo}`);
    throw new Error('Esta entrada no está validada y no puede canjearse.');
  }
  const ent = docEntrada.data() || {};
  if (ent.validado !== true) {
    console.warn(`⛔ PRE encontrada pero no validada: ${codigo}`);
    throw new Error('Esta entrada no está validada y no puede canjearse.');
  }

  // ✅ 2) Marcar en Google Sheets del evento: Columna E = "SÍ" + fondo rojo
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // IDs reales de las 5 hojas de eventos
    const SHEETS_EVENTOS = {
      'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
      'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
      'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
      'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
      'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
    };

    // Si Firestore guardó el slug del evento, usamos esa hoja; si no, probamos en las 5
    const slugDeFS = ent.slugEvento && SHEETS_EVENTOS[ent.slugEvento] ? ent.slugEvento : null;
    const idsARevisar = slugDeFS
      ? [SHEETS_EVENTOS[slugDeFS]]
      : Object.values(SHEETS_EVENTOS);

    let actualizado = false;

    for (const spreadsheetId of idsARevisar) {
      try {
        // Sheet/tab ID (primera pestaña)
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetIdNum = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;

        // Buscar el código en la columna C (rango A:E)
        const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A:E' });
        const filas = read.data.values || [];

        let fila1 = -1;
        for (let i = 1; i < filas.length; i++) {
          const c = String(filas[i]?.[2] || '').trim().toUpperCase();
          if (c === codigo.toUpperCase()) { fila1 = i + 1; break; } // 1-based
        }
        if (fila1 === -1) continue;

        // Escribir "SÍ" en E{fila}
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `E${fila1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['SÍ']] }
        });

        // Estilo: fondo rojo + texto blanco negrita en E{fila}
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheetIdNum,
                  startRowIndex: fila1 - 1,
                  endRowIndex: fila1,
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

        console.log(`📕 PRE ${codigo} canjeado → E="SÍ" (rojo) en hoja ${spreadsheetId}, fila ${fila1}`);
        actualizado = true;
        break;
      } catch (e) {
        console.warn(`⚠️ No se pudo actualizar hoja ${spreadsheetId}:`, e?.message || e);
      }
    }

    if (!actualizado) {
      console.warn(`⚠️ PRE ${codigo} no se encontró en ninguna hoja de eventos para marcar E="SÍ".`);
    }
  } catch (e) {
    console.warn('⚠️ Error al intentar marcar PRE en Sheets:', e?.message || e);
    // No lanzamos: el canje continúa aunque falle el marcado visual
  }
}


  // 2) Bloquear código en Firestore antes de MemberPress
  console.log('🔒 Bloqueando código en Firestore antes de activar…');
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
  console.log('✅ Código bloqueado en Firestore');

  // 3) Registrar en "Libros GRATIS" (bloqueante)
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
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
    console.log('✅ Registrado en hoja "Libros GRATIS"');
  } catch (e) {
    console.warn('⚠️ No se pudo registrar en "Libros GRATIS":', e?.message || e);
  }

  // 4) Activar membresía directamente en MemberPress (API oficial)
  try {
    console.log('🔐 Activando membresía directa en MemberPress…');

    let membershipId = null;
    const tituloLower = libroNormalizado.toLowerCase();

    if (tituloLower.includes('de cara a la jubilación')) {
      membershipId = 7994;
    } else if (tituloLower.includes('adelanta tu jubilación')) {
      membershipId = 11006;
    } else if (
      tituloLower.includes('jubilación anticipada') ||
      tituloLower.includes('jubilación parcial')
    ) {
      membershipId = 11006;
    } else {
      throw new Error(`No se reconoce el libro para activar membresía: ${libroNormalizado}`);
    }

    await activarMembresiaEnMemberPress(emailNormalizado, membershipId);
    console.log('✅ Membresía activada correctamente');
    await canjeRef.update({ activado: true });

  } catch (err) {
    console.error('❌ Error activando membresía directa:', err?.message || err);
  }

  // 5) Registros auxiliares (no bloqueantes)
  (async () => {
    try {
      await registrarCanjeEnSheet({
        nombre,
        apellidos,
        email: emailNormalizado,
        codigo,
        libro: libroNormalizado
      });
    } catch (e) {
      console.warn('⚠️ No se pudo registrar en hoja de canjes general:', e?.message || e);
    }
  })();

  if (esRegalo) {
    (async () => {
      try {
        await marcarCodigoComoCanjeado(codigo);
      } catch (e) {
        console.warn('⚠️ No se pudo marcar en hoja de control REG-:', e?.message || e);
      }
    })();
  }

  console.log(`✅ Canje completado: ${codigo} → ${emailNormalizado} (${motivo})`);
  return { ok: true };
};
