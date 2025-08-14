// 📂 Archivo: regalos/services/canjear-codigo-regalo.js
const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet = require('./registrarCanjeEnSheet');
const { activarMembresiaDirecta } = require('../../utils/memberpress/activarMembresiaDirecta');

const SHEET_ID_REGALOS  = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL  = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

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
        range: `${SHEET_NAME_CONTROL}!A2:C`
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
  } else {
    console.warn(`⛔ Prefijo desconocido en código: ${codigo}`);
    throw new Error('El código introducido no es válido.');
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
      range: `${SHEET_NAME_REGALOS}!A2:G`,
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

  // 4) Activar membresía directamente en MemberPress (sin Stripe)
    try {
      console.log('🔐 Activando membresía directa en MemberPress…');

      let membershipId = null;
      const tituloLower = libroNormalizado.toLowerCase();

      if (tituloLower.includes('de cara a la jubilación')) {
        membershipId = 7994;
      } else if (tituloLower.includes('adelanta tu jubilación')) {
        membershipId = 12009;
      } else if (
        tituloLower.includes('jubilación anticipada') ||
        tituloLower.includes('jubilación parcial')
      ) {
        membershipId = 11006;
      } else {
        throw new Error(`No se reconoce el libro para activar membresía: ${libroNormalizado}`);
      }

      await activarMembresiaDirecta(emailNormalizado, membershipId);
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
