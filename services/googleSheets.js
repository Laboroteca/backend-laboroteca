// services/guardarEnGoogleSheets.js
const { google } = require('googleapis');

const credentialsBase64 = process.env.GCP_CREDENTIALS_BASE64;
if (!credentialsBase64) {
  throw new Error('❌ Falta la variable de entorno GCP_CREDENTIALS_BASE64 con las credenciales de Google');
}

const credentials = JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf8'));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// IDs de Sheets destino (el 1º es el actual; el 2º es el espejo)
const SPREADSHEET_IDS = [
  '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I', // principal
  '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk', // espejo
];

const HOJA = 'Hoja 1';

// 🧽 Normalización de texto para comparación robusta
const normalizarTexto = (str) =>
  (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Escribe una fila en un sheet concreto si no existe ya (por email+desc+importe+fecha) */
async function escribirSiNoDuplicado(sheets, sheetId, fila, { email, descripcion, importe, fecha }) {
  if (!sheetId) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${HOJA}!A2:K`,
  });
  const filas = res.data.values || [];

  const yaExiste = filas.some((f) => {
    const [,, , desc, imp, fec, em] = f;
    return (
      (em || '').toLowerCase() === email &&
      normalizarTexto(desc) === normalizarTexto(descripcion) &&
      (imp || '') === importe &&
      (fec || '') === fecha
    );
  });

  if (yaExiste) {
    console.log(`🔁 Duplicado evitado en ${sheetId} para ${email}`);
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${HOJA}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [fila] },
  });

  console.log(`✅ Compra registrada en ${sheetId} para ${email}`);
}

async function guardarEnGoogleSheets(datos) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const now = new Date();
    const nowString = now.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }); // dd/mm/aaaa (sin hora)

    const email = (datos.email || '').trim().toLowerCase();
    const descripcion = datos.descripcionProducto || datos.nombreProducto || 'Producto Laboroteca';
    const importe = typeof datos.importe === 'number'
      ? `${datos.importe.toFixed(2).replace('.', ',')} €`
      : (datos.importe || '');

    const fila = [
      datos.nombre || '',
      datos.apellidos || '',
      datos.dni || '',
      descripcion,
      importe,
      nowString,
      email,
      datos.direccion || '',
      datos.ciudad || '',
      datos.cp || '',
      datos.provincia || '',
    ];

    // Escribir en TODOS los IDs definidos
    await Promise.all(
      SPREADSHEET_IDS.map((id) =>
        escribirSiNoDuplicado(sheets, id, fila, {
          email,
          descripcion,
          importe,
          fecha: nowString,
        })
      )
    );
  } catch (error) {
    console.error('❌ Error al guardar en Google Sheets:', error);
    throw error;
  }
}

module.exports = { guardarEnGoogleSheets };
