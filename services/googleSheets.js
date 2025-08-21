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
const UID_HEADER = 'uid';         // encabezado esperado (col L)
const UID_COL_INDEX = 11;         // 0-based → 11 = columna L
const GROUP_HEADER = 'groupid';   // col M
const GROUP_COL_INDEX = 12;
const DUP_HEADER = 'duplicado';   // col N
const DUP_COL_INDEX = 13;

// 🧽 Normalización de texto para comparación robusta (fallback)
const normalizarTexto = (str) =>
  (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Escribe una fila en un sheet concreto si no existe ya.
 * Nueva regla: dedupe por UID si está presente; si no hay UID, fallback por (email+desc+importe+fecha).
 */
async function escribirSiNoDuplicado(sheets, sheetId, fila, ctx) {
  if (!sheetId) return;

  // Leemos encabezado para detectar columna UID si existe
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${HOJA}!A1:N1`,
  });
  const header = headerRes.data.values?.[0] || [];
  const headerLower = header.map(h => String(h || '').trim().toLowerCase());
  const uidColInSheet = headerLower.findIndex(h => h === UID_HEADER);
  const groupColInSheet = headerLower.findIndex(h => h === GROUP_HEADER);
  const dupColInSheet = headerLower.findIndex(h => h === DUP_HEADER);

  // Leemos datos (hasta L para incluir UID si lo hay)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${HOJA}!A2:N`,
  });
  const filas = res.data.values || [];

  const { email, descripcion, importe, fecha, uid, groupId } = ctx;
  // Índices efectivos (si no hay header, usamos las columnas L/M/N)
  const uidIdx   = uidColInSheet   >= 0 ? uidColInSheet   : UID_COL_INDEX;
  const groupIdx = groupColInSheet >= 0 ? groupColInSheet : GROUP_COL_INDEX;
  const dupIdx   = dupColInSheet   >= 0 ? dupColInSheet   : DUP_COL_INDEX;

  // 1) Dedupe por UID si tenemos UID y la hoja ya tiene columna UID
  if (uid) {
    const existeUid = filas.some(f => (f[uidIdx] || '').toString().trim() === uid);
    if (existeUid) {
      console.log(`🔁 Duplicado evitado por UID en ${sheetId} → ${uid}`);
      return;
    }
  }
  // 1.5) Marcar duplicado lógico (mismo groupId, distinto uid). NO evita insertar; solo marca.
  let duplicadoFlag = '';
  if (groupId) {
    const hayOtroMismoGrupoConOtroUid = filas.some(f => {
      const g = (f[groupIdx] || '').toString().trim();
      const u = (f[uidIdx]   || '').toString().trim();
      return g === groupId && (!!uid ? u !== uid : true);
    });
    if (hayOtroMismoGrupoConOtroUid) {
      duplicadoFlag = 'YES';
      console.warn(`⚠️ Doble factura lógica detectada (groupId=${groupId}) en sheet ${sheetId}`);
    }
  }

  console.log('[Sheets] uid-debug', {
  uid,
  uidColInSheet, groupColInSheet, dupColInSheet,
  effectiveIdx: { uidIdx, groupIdx, dupIdx },
  sheetId,
  hoja: HOJA
});

  // 2) Fallback: si no hay UID o la hoja aún no tiene columna UID, dedupe por contenido (antiguo criterio)
  if (!uid) {
    const yaExiste = filas.some((f) => {
      // A,B,C,D,E,F,G,H,I,J,K,(L=UID opcional)
      const [,, , desc, imp, fec, em] = f;
      return (
        (em || '').toLowerCase() === email &&
        normalizarTexto(desc) === normalizarTexto(descripcion) &&
        (imp || '') === importe &&
        (fec || '') === fecha
      );
    });
    if (yaExiste) {
      console.log(`🔁 Duplicado evitado por contenido en ${sheetId} para ${email}`);
      return;
    }
  }
    
  // 2.5) Escribir el flag de duplicado en la fila antes de hacer append
  if (duplicadoFlag) {
    // Asegura longitud
    while (fila.length <= dupIdx) fila.push('');
    fila[dupIdx] = duplicadoFlag;
  }

  // 3) Append fila (ya incluye UID en la última columna)
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${HOJA}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [fila] },
  });

  console.log(`✅ Compra registrada en ${sheetId} para ${email}${uid ? ` (uid=${uid})` : ''}`);
}

async function guardarEnGoogleSheets(datos) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const now = new Date();
    const nowString = now.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }); // dd/mm/aaaa

    const email = (datos.email || '').trim().toLowerCase();
    const descripcion = datos.descripcionProducto || datos.nombreProducto || 'Producto Laboroteca';
    const importe = typeof datos.importe === 'number'
      ? `${datos.importe.toFixed(2).replace('.', ',')} €`
      : (datos.importe || '');
    // UID transaccional: prioridad FacturaCity → Stripe PI/Invoice → Session → fallback vacío
    const uid = String(
      datos.uid ||
      datos.facturaId ||           // FacturaCity
      datos.invoiceId ||           // a veces llamas así a FacturaCity
      datos.invoiceIdStripe ||     // PaymentIntent o invoice de Stripe según tu flujo
      datos.sessionId ||           // checkout.session id
      ''
    ).trim();
    const groupId = String(datos.groupId || '').trim();

    // La fila añade UID como última columna (L)
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
      uid || '',        // L
      groupId || '',    // M
      ''                // N (duplicado) → lo setea escribirSiNoDuplicado con `duplicadoFlag` (ya calculado arriba)
    ];

    // Escribir en TODOS los IDs definidos, usando dedupe por UID si es posible
    await Promise.all(
      SPREADSHEET_IDS.map((id) =>
      escribirSiNoDuplicado(sheets, id, fila, { email, descripcion, importe, fecha: nowString, uid, groupId })

      )
    );
  } catch (error) {
    console.error('❌ Error al guardar en Google Sheets:', error);
    throw error;
  }
}

module.exports = { guardarEnGoogleSheets };
