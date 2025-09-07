'use strict';

const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ================== CONFIG ================== */
const SHEET_ID =
  process.env.SHEET_ID_DESCUENTOS ||
  '15ruIDI8avTYm1-7ElAEWI6eX89wzkLnoFt-E9yuSLVs';
const SHEET_NAME = 'CODIGOS DESCUENTO GENERADOS';

/* 🎨 Colores por defecto */
const COLOR_VERDE = { red: 0.2, green: 0.8, blue: 0.2 };
const TEXTO_BLANCO_BOLD = {
  foregroundColor: { red: 1, green: 1, blue: 1 },
  bold: true,
};

/**
 * Crear un código descuento (idempotente).
 * - Firestore: codigosDescuento
 * - Sheets: nueva fila con "NO" (verde)
 */
async function crearCodigoDescuento({ nombre, email, codigo, valor, otorganteEmail }) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!/^DSC-[A-Z0-9]{5}$/.test(cod)) {
    throw new Error(`Formato código inválido (${cod})`);
  }

  // Idempotencia: si ya existe, devolvemos sin error
  const docRef = firestore.collection('codigosDescuento').doc(cod);
  const snap = await docRef.get();
  if (snap.exists) {
    console.log(`ℹ️ Código ${cod} ya existía (idempotencia).`);
    return { ok: true, codigo: cod, idempotente: true };
  }

  const ahoraISO = new Date().toISOString();
  const data = {
    nombre: String(nombre || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    valor: Number(valor) || 0,
    otorganteEmail: String(otorganteEmail || '').trim().toLowerCase(),
    creadoEn: ahoraISO,
    usado: false,
  };

  // 1️⃣ Guardar en Firestore
  await docRef.set(data, { merge: true });

  // 2️⃣ Registrar en Sheets
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Añadir nueva fila al final
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [
          [
            data.nombre,
            data.email,
            cod,
            `${data.valor} €`,
            'NO',
          ],
        ],
      },
    });

    // Estilo visual (verde + bold blanco) en la celda "NO"
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME);

    if (sheet) {
      const rowCount = sheet.properties.gridProperties.rowCount;
      const rowNumber = rowCount; // última fila recién añadida

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: rowNumber - 1,
                  endRowIndex: rowNumber,
                  startColumnIndex: 4,
                  endColumnIndex: 5,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: COLOR_VERDE,
                    textFormat: TEXTO_BLANCO_BOLD,
                  },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat)',
              },
            },
          ],
        },
      });
    }
  } catch (e) {
    console.warn(`⚠️ Error actualizando Sheets al crear ${cod}:`, e.message || e);
    await alertAdmin({
      area: 'descuentos.crear.sheets_error',
      err: e,
      meta: { codigo: cod, email },
    });
  }

  console.log(`✅ Código ${cod} creado para ${email} (${valor} €)`);
  return { ok: true, codigo: cod, valor: data.valor };
}

module.exports = { crearCodigoDescuento };
