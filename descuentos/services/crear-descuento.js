// 📂 descuentos/services/crear-descuento.js
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

/* 🎨 Estilos */
const COLOR_VERDE = { red: 0.2, green: 0.8, blue: 0.2 };
const TEXTO_BLANCO_BOLD = {
  foregroundColor: { red: 1, green: 1, blue: 1 },
  bold: true,
};

/**
 * Crear un código descuento (idempotente).
 * - Firestore: codigosDescuento
 * - Sheets: fila nueva con fecha + datos + "NO" en G (verde)
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

  const ahora = new Date();
  const fechaStr = ahora.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const horaStr = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fechaHora = `${fechaStr} ${horaStr}h`;

  const ahoraISO = ahora.toISOString();
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

  // 2️⃣ Registrar en Google Sheets
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Añadir nueva fila (A..G). G = "Canjeado"
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          fechaHora,                   // A: Fecha
          data.nombre,                 // B: Nombre beneficiario
          data.email,                  // C: Email
          cod,                         // D: Código Descuento
          `${data.valor} €`,           // E: Valor del descuento
          data.otorganteEmail || '',   // F: ¿Quién ha generado?
          'NO',                        // G: Canjeado
        ]],
      },
    });

    // Estilo verde + texto blanco en la celda G de esa fila
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find((s) => s.properties.title === SHEET_NAME);

    if (sheet) {
      const read = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_NAME}'!D:D`, // ahora los códigos están en la columna D
      });

      const rows = read.data.values || [];
      const idx = rows.findIndex(r => (r[0] || '').toString().trim().toUpperCase() === cod);

      if (idx >= 0) {
        const rowNumber = idx + 1; // filas en A1 empiezan en 1

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [{
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: rowNumber - 1,
                  endRowIndex: rowNumber,
                  startColumnIndex: 6, // Columna G (0=A → G=6)
                  endColumnIndex: 7,
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: COLOR_VERDE,
                    textFormat: TEXTO_BLANCO_BOLD,
                  },
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat)',
              },
            }],
          },
        });
      } else {
        console.warn(`⚠️ Código ${cod} no localizado en '${SHEET_NAME}' para aplicar estilo`);
      }
    }
  } catch (e) {
    console.warn(`⚠️ Error actualizando Sheets al crear ${cod}:`, e.message || e);
    try {
      await alertAdmin({
        area: 'descuentos.crear.sheets_error',
        err: e,
        meta: { codigo: cod, email, sheet: SHEET_NAME },
      });
    } catch (_) {}
  }

  console.log(`✅ Código ${cod} creado para ${email} (${valor} €)`);
  return { ok: true, codigo: cod, valor: data.valor };
}

module.exports = { crearCodigoDescuento };
