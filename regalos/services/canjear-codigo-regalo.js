const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const activarMembresiaPorRegalo = require('./activarMembresiaPorRegalo');
const registrarCanjeEnSheet = require('./registrarCanjeEnSheet');

const SHEET_ID_REGALOS  = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL  = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

// Pequeño helper de reintentos con backoff
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

  // ⛔️ Si ya está canjeado, cortamos (idempotencia)
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
      throw new Error('Requested entity was not found'); // mapea a "Código inválido"
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
      throw new Error('Requested entity was not found'); // "Código inválido"
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
    const emailComprador = String(ent.emailComprador || '').trim().toLowerCase();
    if (emailComprador && emailComprador !== emailNormalizado) {
      console.warn(`⛔ PRE email mismatch: entrada=${emailComprador} vs req=${emailNormalizado}`);
      throw new Error('Esta entrada validada no corresponde con tu email.');
    }
  } else {
    console.warn(`⛔ Prefijo desconocido en código: ${codigo}`);
    throw new Error('El código introducido no es válido.');
  }

  // 2) ACTIVAR MEMBRESÍA EN MEMBERPRESS (BLOQUEANTE)
  // Si falla, NO se marca el código como usado.
  console.log('🔐 Activando membresía en MemberPress…');
  await activarMembresiaPorRegalo(emailNormalizado, libroNormalizado);
  console.log('✅ Membresía activada en MemberPress');

  // 3) Registrar canje (BLOQUEANTE con reintentos)
  // Usamos create() para evitar sobrescribir si por carrera ya existe.
  console.log('📝 Registrando canje en Firestore…');
  await withRetries(async () => {
    await canjeRef.create({
      nombre,
      apellidos,
      email: emailNormalizado,
      libro: libroNormalizado,
      motivo, // REGALO | ENTRADA
      fecha: timestamp
    });
  }, { tries: 5, baseMs: 150 });
  console.log('✅ Canje registrado en Firestore');

  // 4) Registros auxiliares (NO bloqueantes)
  // 4.1) Libros GRATIS
  (async () => {
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
    } catch (e) {
      console.warn('⚠️ No se pudo registrar en "Libros GRATIS":', e?.message || e);
    }
  })();

  // 4.2) Canjes general
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

  // 4.3) Marcar visual en hoja de control (solo REG-)
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