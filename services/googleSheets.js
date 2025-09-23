// services/googleSheets.js
const { google } = require('googleapis');
const crypto = require('crypto');
const { ensureOnce } = require('../utils/dedupe');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// PII-safe helper para logs
const maskEmail = (e = '') => {
  const [u, d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@***${d.slice(Math.max(0, d.length - 3))}`;
};


const credentialsBase64 = process.env.GCP_CREDENTIALS_BASE64;
if (!credentialsBase64) {
  throw new Error('❌ Falta la variable de entorno GCP_CREDENTIALS_BASE64 con las credenciales de Google');
}

let credentials;
try {
  credentials = JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf8'));
} catch (e) {
  throw new Error('❌ GCP_CREDENTIALS_BASE64 no es JSON válido (revísalo).');
}

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
// índice 0-based → letra A1
function colToA1(idx) {
  let n = idx + 1, s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
// Backoff simple para 429/5xx
async function withRetries(fn, { tries = 3, baseMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      const code = Number(e?.code || e?.response?.status || 0);
      if (i < tries - 1 && (code === 429 || code >= 500)) {
        const delay = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 150); // jitter
        await new Promise(r => setTimeout(r, delay));
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Normaliza importes para comparar (quita €, espacios y unifica separadores)
function normalizarImporte(str) {
  const s = String(str || '')
    .replace(/€/g, '')
    .replace(/\s+/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
}

// Fecha siempre en formato XX/XX/XXXX (con ceros a la izquierda)
function fmtES(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const dd = parts.find(p => p.type === 'day')?.value ?? '';
  const mm = parts.find(p => p.type === 'month')?.value ?? '';
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '';
  return `${dd}/${mm}/${yyyy}`;
}

// Siembra encabezados si faltan (no pisa los ya presentes)
async function seedHeadersIfMissing(sheets, sheetId, header) {
  const map = { [UID_COL_INDEX]: 'uid', [GROUP_COL_INDEX]: 'groupid', [DUP_COL_INDEX]: 'duplicado' };
  const merged = [...header];
  Object.entries(map).forEach(([i, name]) => {
    const idx = Number(i);
    if (!merged[idx] || String(merged[idx]).trim() === '') merged[idx] = name;
  });

  // ¿ya están?
  const ok = Object.entries(map).every(([i, name]) =>
    String(merged[Number(i)]).trim().toLowerCase() === name
  );
  if (ok) return;

   const lastIdx = Math.max(...Object.keys(map).map(Number), merged.length - 1);
   const toColA1 = colToA1(lastIdx);
   await withRetries(() => sheets.spreadsheets.values.update({
     spreadsheetId: sheetId,
     range: `${HOJA}!A1:${toColA1}1`,
     valueInputOption: 'RAW',
     requestBody: { values: [merged] },
   }));
}


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

    // Leemos encabezado con backoff y sembramos headers si faltan
  let headerRes;
  try {
    headerRes = await withRetries(() => sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${HOJA}!A1:N1`,
    }));
  } catch (e) {
    await alertAdmin({
      area: 'sheets_read_header',
      email: ctx?.email || '-',
      err: e,
      meta: { sheetId, hoja: HOJA }
    });
    throw e;
  }

  const header = headerRes.data.values?.[0] || [];
    try {
    await seedHeadersIfMissing(sheets, sheetId, header);
  } catch (e) {
    await alertAdmin({
      area: 'sheets_seed_headers',
      email: ctx?.email || '-',
      err: e,
      meta: { sheetId, hoja: HOJA, header }
    });
    throw e;
  }


    const headerLower = header.map(h => String(h || '').trim().toLowerCase());
    const uidColInSheet   = headerLower.findIndex(h => h === UID_HEADER);
    const groupColInSheet = headerLower.findIndex(h => h === GROUP_HEADER);
    const dupColInSheet   = headerLower.findIndex(h => h === DUP_HEADER);

    // Índices efectivos (si no hubiera encabezado válido)
    const uidIdx   = uidColInSheet   >= 0 ? uidColInSheet   : UID_COL_INDEX;
    const groupIdx = groupColInSheet >= 0 ? groupColInSheet : GROUP_COL_INDEX;
    const dupIdx   = dupColInSheet   >= 0 ? dupColInSheet   : DUP_COL_INDEX;

    // Localiza columnas lógicas por header; fallback a D,E,F,G (3..6)
    const findIdx = (aliases) => {
      const idx = headerLower.findIndex(h => aliases.includes(h));
      return idx >= 0 ? idx : -1;
    };
    const descIdx = findIdx(['descripcion', 'descripcionproducto', 'concepto', 'descripción']);
    const impIdx  = findIdx(['importe', 'precio', 'total']);
    const fecIdx  = findIdx(['fecha', 'fecha compra', 'fecha_compra']);
    const emIdx   = findIdx(['email', 'correo', 'correo electronico', 'correo_electronico']);

    const descEff = descIdx >= 0 ? descIdx : 3;
    const impEff  = impIdx  >= 0 ? impIdx  : 4;
    const fecEff  = fecIdx  >= 0 ? fecIdx  : 5;
    const emEff   = emIdx   >= 0 ? emIdx   : 6;

    const uidColA1   = colToA1(uidIdx);
    const groupColA1 = colToA1(groupIdx);
    const descColA1  = colToA1(descEff);
    const impColA1   = colToA1(impEff);
    const fecColA1   = colToA1(fecEff);
    const emColA1    = colToA1(emEff);

    // Lectura por columnas independientes
    const batches = await withRetries(() => sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: [
        `${HOJA}!${uidColA1}2:${uidColA1}`,
        `${HOJA}!${groupColA1}2:${groupColA1}`,
        `${HOJA}!${descColA1}2:${descColA1}`,
        `${HOJA}!${impColA1}2:${impColA1}`,
        `${HOJA}!${fecColA1}2:${fecColA1}`,
        `${HOJA}!${emColA1}2:${emColA1}`,
      ],
    }));
    const rangeL   = batches.data.valueRanges?.[0]?.values || [];
    const rangeM   = batches.data.valueRanges?.[1]?.values || [];
    const descCol  = batches.data.valueRanges?.[2]?.values || [];
    const impCol   = batches.data.valueRanges?.[3]?.values || [];
    const fecCol   = batches.data.valueRanges?.[4]?.values || [];
    const emCol    = batches.data.valueRanges?.[5]?.values || [];

    const { email, descripcion, importe, fecha, uid, groupId } = ctx;


  console.log('[Sheets] uid-debug', {
    uid,
    uidColInSheet, groupColInSheet, dupColInSheet,
    effectiveIdx: { uidIdx, groupIdx, dupIdx },
    sheetId, hoja: HOJA
  });

  // 1) Dedupe por UID (si viene)
  if (uid) {
    const existeUid = rangeL.some(r => (r?.[0] || '').toString().trim() === uid);
    if (existeUid) {
      console.log(`🔁 Duplicado evitado por UID en ${sheetId} → ${uid}`);
      return;
    }
    // Cerrojo atómico cross-proceso (evita carreras get/append simultáneas)
    const wrote = await ensureOnce('sheetsWrite', `sheets:${sheetId}:uid:${uid}`);
    if (!wrote) {
      console.log(`🟡 Carrera evitada por uid en ${sheetId} → ${uid}`);
      return;
    }
  }

  // 1.5) Flag lógico de duplicado por groupId (no evita insertar)
  let duplicadoFlag = '';
  if (groupId) {
    const hayOtro = rangeM.some(r => (r?.[0] || '').toString().trim() === groupId);
    if (hayOtro) {
      duplicadoFlag = 'YES';
      console.warn(`⚠️ Doble factura lógica detectada (groupId=${groupId}) en sheet ${sheetId}`);
    }
  }

  // 2) Fallback sin UID: dedupe por contenido normalizado
  if (!uid) {
    const impNormObjetivo = String(importe); // ya viene normalizado desde guardarEnGoogleSheets
    const maxLen = Math.max(descCol.length, impCol.length, fecCol.length, emCol.length);
    const yaExiste = Array.from({ length: maxLen }).some((_, i) => {
      const desc = descCol[i]?.[0] || '';
      const imp  = impCol[i]?.[0]  || '';
      const fec  = fecCol[i]?.[0]  || '';
      const em   = emCol[i]?.[0]   || '';
      return (
        (em || '').toLowerCase() === email &&
        normalizarTexto(desc) === normalizarTexto(descripcion) &&
        normalizarImporte(imp) === impNormObjetivo &&
        (fec || '') === fecha
      );
    });
    if (yaExiste) {
      console.log(`🔁 Duplicado evitado por contenido en ${sheetId} para ${maskEmail(email)}`);
      return;
    }
    // Cerrojo atómico por contenido
    // Añadimos hora al key para reducir carreras sin tocar el layout de la hoja
    const contentKeyRaw = `${email}|${normalizarTexto(descripcion)}|${impNormObjetivo}|${fecha}|${(ctx?.hora || '')}|${sheetId}`;
    const contentKey = crypto.createHash('sha1').update(contentKeyRaw).digest('hex');
    const wrote = await ensureOnce('sheetsWrite', `sheets:${sheetId}:content:${contentKey}`);
    if (!wrote) {
      console.log(`🟡 Carrera evitada por contenido en ${sheetId}`);
      return;
    }
  }

  // 2.5) Si hay flag de duplicado, lo añadimos en su columna
  if (duplicadoFlag) {
    while (fila.length <= dupIdx) fila.push('');
    fila[dupIdx] = duplicadoFlag;
  }


  // 3) Append fila (ya incluye UID en la última columna)
  try {
    await withRetries(() => sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${HOJA}!A2`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    }));
  } catch (e) {
    // En meta no mandamos toda la fila para no alargar; incluimos campos clave
    await alertAdmin({
      area: 'sheets_append',
      email: ctx?.email || '-',
      err: e,
      meta: {
        sheetId,
        hoja: HOJA,
        uid: ctx?.uid || '',
        groupId: ctx?.groupId || '',
        descripcion: ctx?.descripcion || '',
        importe: ctx?.importe,
        fecha: ctx?.fecha
      }
    });
    throw e;
  }



  console.log(`✅ Compra registrada en ${sheetId} para ${maskEmail(email)}${uid ? ` (uid=${uid})` : ''}`);
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
    const importeForCompare = typeof datos.importe === 'number'
      ? datos.importe.toFixed(2)
      : normalizarImporte(datos.importe);

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

// Escribir en principal (obligatorio) y espejos no bloqueantes
{
  const tz = 'Europe/Madrid';
  const nowTime = now.toLocaleTimeString('es-ES', { timeZone: tz, hour12: false }); // HH:MM:SS

  const ctxBase = {
    email,
    descripcion,
    importe: importeForCompare,
    fecha: nowString,
    hora: nowTime,
    uid,
    groupId,
  };

  const [principalId, ...mirrors] = SPREADSHEET_IDS;

  if (!principalId) {
    throw new Error('❌ No hay SPREADSHEET_IDS configurados');
  }

  // 1) Principal: si falla, dejamos que burbujee (debe quedar registrado sí o sí)
  await escribirSiNoDuplicado(sheets, principalId, fila, ctxBase);

  // 2) Espejos: best-effort; no bloquean el flujo
  for (const id of mirrors) {
    try {
      await escribirSiNoDuplicado(sheets, id, fila, ctxBase);
    } catch (e) {
      console.warn(`[Sheets espejo] fallo en ${id}:`, e?.message || e);
      // Aviso por sheet (sin bloquear)
      try {
        await alertAdmin({
          area: 'sheets_guardar_por_sheet',
          email,
          err: e,
          meta: { sheetId: id, hoja: HOJA, uid, groupId },
        });
      } catch (ae) {
        console.warn('[Sheets espejo] fallo al alertar admin:', ae?.message || ae);
      }
      // no relanzamos: espejo no bloquea
    }
  }
}

} catch (error) {
  console.error('❌ Error al guardar en Google Sheets:', error);
  // Aviso global (puede agrupar fallos de auth, client, principal, etc.)
  try {
    await alertAdmin({
      area: 'sheets_guardar_global',
      email: (datos?.email || '').toLowerCase() || '-',
      err: error,
      meta: {
        hoja: HOJA,
        spreadsheets: SPREADSHEET_IDS,
        uid: String(
          datos?.uid ||
          datos?.facturaId ||
          datos?.invoiceId ||
          datos?.invoiceIdStripe ||
          datos?.sessionId || ''
        ).trim(),
        groupId: String(datos?.groupId || '').trim(),
      },
    });
  } catch (ae) {
    console.warn('[Sheets] fallo al alertar admin (global):', ae?.message || ae);
  }
  throw error;
}

}

module.exports = { guardarEnGoogleSheets };
