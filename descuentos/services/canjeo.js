// 📂 descuentos/services/canjeo.js
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

/* 🎨 Colores condicionales */
const COLOR_ROJO = { red: 0.9, green: 0.13, blue: 0.13 };
const TEXTO_BLANCO_BOLD = {
  foregroundColor: { red: 1, green: 1, blue: 1 },
  bold: true,
};

/**
 * Marca un código descuento como usado (idempotente).
 *   1. Firestore → colecciones codigosDescuento y codigosDescuentoUsados
 *   2. Sheets → cambia "NO" → "SÍ" con formato rojo
 *
 * @param {string} codigo Código descuento (ej. DSC-ABCDE)
 * @returns {Promise<{codigo: string, usado: boolean, idempotente?: boolean}>}
 */
async function marcarCodigoComoUsado(codigo) {
  const cod = String(codigo || '').trim().toUpperCase();
  if (!/^DSC-[A-Z0-9]{5}$/.test(cod)) {
    throw new Error(`Formato código inválido (${cod})`);
  }

  const docRef = firestore.collection('codigosDescuento').doc(cod);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error(`Código ${cod} no existe`);

  const data = snap.data() || {};

  // 🔄 Idempotencia: si ya estaba usado, no rompemos
  if (data.usado) {
    console.log(`ℹ️ Código ${cod} ya estaba marcado como USADO (idempotencia)`);
    return { codigo: cod, usado: true, idempotente: true };
  }

  const ahoraISO = new Date().toISOString();

  // 1️⃣ Marcar en colección principal
  await docRef.set({ usado: true, canjeadoEn: ahoraISO }, { merge: true });

  // 2️⃣ Copiar en colección inmutable
  await firestore.collection('codigosDescuentoUsados').doc(cod).set(
    {
      ...data,
      usado: true,
      canjeadoEn: ahoraISO,
    },
    { merge: true }
  );

  // 3️⃣ Actualizar Google Sheets
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Col C = código, col F = Canjeado
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!C:C`,
    });

    const rows = read.data.values || [];
    const idx = rows.findIndex(
      (r) => (r[0] || '').toString().trim().toUpperCase() === cod
    );

    if (idx >= 0) {
      const rowNumber = idx + 1;

      // Cambiar valor en la columna F
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_NAME}'!F${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['SÍ']] },
      });

      // Cambiar estilo visual (rojo + bold blanco)
      const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
      const sheet = meta.data.sheets.find(
        (s) => s.properties.title === SHEET_NAME
      );

      if (sheet) {
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
                    startColumnIndex: 5,  // F (0=A)
                    endColumnIndex: 6,
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: COLOR_ROJO,
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
    } else {
      console.warn(`⚠️ Código ${cod} no encontrado en hoja (${SHEET_NAME})`);
    }
  } catch (e) {
    console.warn(`⚠️ Error actualizando Sheets para ${cod}:`, e.message || e);
    await alertAdmin({
      area: 'descuentos.canjeo.sheets_error',
      err: e,
      meta: { codigo: cod },
    });
  }

  console.log(`✅ Código ${cod} marcado como USADO`);
  return { codigo: cod, usado: true };
}

module.exports = { marcarCodigoComoUsado };
