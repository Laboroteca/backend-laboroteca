// 📂 Ruta: /regalos/services/canjear-codigo-regalo.js

const admin = require('../../firebase');
const firestore = admin.firestore();
const dayjs = require('dayjs');
const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const activarMembresiaPorRegalo = require('./activarMembresiaPorRegalo');
const registrarCanjeEnSheet = require('./registrarCanjeEnSheet');

const SHEET_ID_REGALOS = '1MjxXebR3oQIyu0bYeRWo83xj1sBFnDcx53HvRRBiGE'; // 📄 Libros GRATIS
const SHEET_NAME_REGALOS = 'Hoja 1';

const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo'; // 📄 Códigos REG- activos
const SHEET_NAME_CONTROL = 'Hoja 1';

/**
 * Canjea un código regalo si es válido y no ha sido utilizado.
 * @param {Object} params
 * @param {string} params.nombre
 * @param {string} params.apellidos
 * @param {string} params.email
 * @param {string} params.libro_elegido
 * @param {string} params.codigo_regalo
 */
module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo,
}) {
  // 🔹 Normalizar datos
  const codigo = String(codigo_regalo || '').trim().toUpperCase();
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const libroNormalizado = String(libro_elegido || '').trim();
  const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');

  if (!nombre || !emailNormalizado || !libroNormalizado || !codigo) {
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo = codigo.startsWith('REG-');
  const esEntrada = codigo.startsWith('PRE-');
  const motivo = esRegalo ? 'REGALO' : esEntrada ? 'ENTRADA' : 'OTRO';

  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  // 1️⃣ Verificar si ya fue usado
  const docRef = firestore.collection('regalos_canjeados').doc(codigo);
  const doc = await docRef.get();
  if (doc.exists) {
    throw new Error('Este código ya ha sido utilizado.');
  }

  // 2️⃣ Validar contra hoja de control
  const controlRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_CONTROL,
    range: `${SHEET_NAME_CONTROL}!A2:C`,
  });

  const filas = controlRes.data.values || [];
  const fila = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigo);

  if (!fila) {
    throw new Error('El código introducido no es válido.');
  }

  // Validar que el email asignado coincide (solo para regalos)
  const emailAsignado = String(fila[1] || '').trim().toLowerCase();
  if (esRegalo && emailAsignado && emailAsignado !== emailNormalizado) {
    throw new Error('Este código regalo no corresponde con tu email.');
  }

  // 3️⃣ Guardar canje en Firebase
  await docRef.set({
    nombre,
    apellidos,
    email: emailNormalizado,
    libro: libroNormalizado,
    motivo,
    fecha: timestamp,
  });

  // 4️⃣ Guardar en hoja "Libros GRATIS"
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
        codigo,
      ]],
    },
  });

  // 5️⃣ Registrar también en hoja de canjes general
  await registrarCanjeEnSheet({
    nombre,
    apellidos,
    email: emailNormalizado,
    codigo,
    libro: libroNormalizado,
    origen: motivo,
  });

  // 6️⃣ Marcar como canjeado (color rojo en hoja control)
  await marcarCodigoComoCanjeado(codigo);

  // 7️⃣ Activar la membresía correspondiente
  await activarMembresiaPorRegalo(emailNormalizado, libroNormalizado);

  console.log(`✅ Código ${codigo} canjeado correctamente para ${emailNormalizado}`);
  return { ok: true };
};
