// 📂 Ruta: /regalos/services/canjear-codigo-regalo.js

const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const activarMembresiaPorRegalo = require('./activarMembresiaPorRegalo');
const registrarCanjeEnSheet = require('./registrarCanjeEnSheet');

const SHEET_ID_REGALOS = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // Libros GRATIS
const SHEET_NAME_REGALOS = 'Hoja 1';

const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

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

  // 0) Evitar canje duplicado
  const docRefCanje = firestore.collection('regalos_canjeados').doc(codigo);
  const docCanje = await docRefCanje.get();
  if (docCanje.exists) {
    console.warn(`⛔ Código ya canjeado previamente: ${codigo}`);
    throw new Error('Este código ya ha sido utilizado.');
  }

  // 1) Validación de origen
  if (esRegalo) {
    // ✅ REG- → validar contra hoja de control
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
      // Si falla el GET o la hoja no existe, tratamos como inválido
      if (e?.message) console.warn('⚠️ Error validando REG- en hoja de control:', e.message);
      throw new Error('Requested entity was not found'); // mapea a "Código inválido"
    }

  } else if (esEntrada) {
    // ✅ PRE- → validar SOLO si está en Firestore: entradasValidadas/{codigo} con validado=true
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

  // 2) Registrar canje en Firestore (canje efectivo)
  await docRefCanje.set({
    nombre,
    apellidos,
    email: emailNormalizado,
    libro: libroNormalizado,
    motivo, // REGALO | ENTRADA
    fecha: timestamp
  });

  // 3) Registrar en hoja "Libros GRATIS" (NO bloqueante)
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

  // 4) Registrar en hoja de canjes general (NO bloqueante)
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

  // 5) Solo marcar en hoja de control cuando sea REG- (NO bloqueante)
  if (esRegalo) {
    try {
      await marcarCodigoComoCanjeado(codigo);
    } catch (e) {
      console.warn('⚠️ No se pudo marcar en hoja de control REG-:', e?.message || e);
    }
  }

  // 6) Activar membresía correspondiente (tanto REG como PRE validadas)
  await activarMembresiaPorRegalo(emailNormalizado, libroNormalizado);

  console.log(`✅ Canje completado: ${codigo} → ${emailNormalizado} (${motivo})`);
  return { ok: true };
};

