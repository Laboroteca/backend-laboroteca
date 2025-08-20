// entradas/routes/crear-entrada-regalo.js
const express = require('express');
const dayjs = require('dayjs');
const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { generarCodigoEntrada, normalizar } = require('../utils/codigos');
const { subirEntrada } = require('../utils/gcsEntradas');
const { registrarEntradaFirestore } = require('../services/registrarEntradaFirestore');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');
const { google } = require('googleapis');
const { auth } = require('../google/sheetsAuth');

const router = express.Router();

// ── Sheets por formulario (fallback al 22)
const MAP_SHEETS = {
  '22': process.env.SHEET_ID_FORM_22 || '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': process.env.SHEET_ID_FORM_39 || '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': process.env.SHEET_ID_FORM_40 || '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': process.env.SHEET_ID_FORM_41 || '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': process.env.SHEET_ID_FORM_42 || '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc',
};
const FALLBACK_22 = MAP_SHEETS['22'];

// ── Metadatos por formulario (se usan SOLO si el frontend no envía los hidden)
const EVENTOS_POR_FORM = {
  '22': {
    descripcionProducto: 'Evento 1',
    nombreProducto: 'Evento 1',
    fechaActuacion: '30/10/2025 - 17:00',
    direccionEvento: 'Dirección evento 1',
    imagenEvento: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-qr-scaled.jpg'
  },
  '39': {
    descripcionProducto: 'Evento 2',
    nombreProducto: 'Evento 2',
    fechaActuacion: '31/10/2025 - 19:00',
    direccionEvento: 'Dirección evento 2',
    imagenEvento: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-qr-scaled.jpg'
  },
  '40': { descripcionProducto: 'Evento 3', nombreProducto: 'Evento 3', fechaActuacion: '', direccionEvento: '', imagenEvento: '' },
  '41': { descripcionProducto: 'Evento 4', nombreProducto: 'Evento 4', fechaActuacion: '', direccionEvento: '', imagenEvento: '' },
  '42': { descripcionProducto: 'Evento 5', nombreProducto: 'Evento 5', fechaActuacion: '', direccionEvento: '', imagenEvento: '' },
};

// Rosa para marcar G="REGALO"
const COLOR_ROSA = { red: 1, green: 0.8, blue: 0.9 };
const TEXTO_BOLD = { bold: true };

function getSheetId(formularioId) {
  const id = String(formularioId || '').trim();
  return MAP_SHEETS[id] || FALLBACK_22;
}

async function appendRegaloRow({ spreadsheetId, fecha, desc, comprador, codigo }) {
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A:G',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[fecha, desc, comprador, codigo, 'NO', 'NO', 'REGALO']] }
  });

  const m = (resp.data?.updates?.updatedRange || '').match(/([A-Z]+)(\d+):/);
  if (m) {
    const row1 = parseInt(m[2], 10);
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetIdNum = meta.data.sheets?.[0]?.properties?.sheetId || 0;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId: sheetIdNum, startRowIndex: row1 - 1, endRowIndex: row1, startColumnIndex: 6, endColumnIndex: 7 },
            cell: { userEnteredFormat: { backgroundColor: COLOR_ROSA, textFormat: TEXTO_BOLD } },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        }]
      }
    });
  }
}

/**
 * POST /entradas/crear-entrada-regalo
 * body: { beneficiarioNombre, beneficiarioEmail, cantidad, formularioId, (opcionales: descripcionProducto, nombreProducto, fechaActuacion, direccionEvento, imagenEvento) }
 */
router.post('/crear-entrada-regalo', async (req, res) => {
  try {
    const beneficiarioNombre = String(req.body?.beneficiarioNombre || '').trim();
    const email              = String(req.body?.beneficiarioEmail || '').trim().toLowerCase();
    const cantidad           = Math.max(1, parseInt(req.body?.cantidad, 10) || 1);
    const formularioId       = String(req.body?.formularioId || '22').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ ok: false, error: 'Email del beneficiario inválido' });

    // Respetar hidden → si no llegan, fallback por formulario
    const base = EVENTOS_POR_FORM[formularioId] || {};
    const descripcionProducto = String((req.body?.descripcionProducto ?? base.descripcionProducto ?? `Evento ${formularioId}`)).trim();
    const nombreProducto      = String((req.body?.nombreProducto      ?? base.nombreProducto      ?? descripcionProducto)).trim();
    const fechaActuacion      = String((req.body?.fechaActuacion      ?? base.fechaActuacion      ?? '')).trim();
    const direccionEvento     = String((req.body?.direccionEvento     ?? base.direccionEvento     ?? '')).trim();
    const imagenEvento        = String((req.body?.imagenEvento        ?? base.imagenEvento        ?? '')).trim();

    const sheetId = getSheetId(formularioId);
    const carpeta = normalizar(descripcionProducto);
    const fechaCompra = dayjs().format('DD/MM/YYYY - HH:mm');

    const buffers = [];
    const codigos = [];

    for (let i = 0; i < cantidad; i++) {
      const codigo = generarCodigoEntrada(normalizar(nombreProducto || descripcionProducto));
      const pdf = await generarEntradaPDF({
        nombre: beneficiarioNombre,
        apellidos: '',
        codigo,
        nombreActuacion: nombreProducto || descripcionProducto,
        fechaActuacion,
        descripcionProducto,
        direccionEvento,
        imagenFondo: imagenEvento
      });

      buffers.push({ buffer: pdf });
      codigos.push(codigo);

      try { await subirEntrada(`entradas/${carpeta}/${codigo}.pdf`, pdf); } catch {}

      try {
        await appendRegaloRow({
          spreadsheetId: sheetId,
          fecha: fechaCompra,
          desc: descripcionProducto,
          comprador: email,
          codigo
        });
      } catch {}

      try {
        await registrarEntradaFirestore({
          codigoEntrada: codigo,
          emailComprador: email,
          nombreAsistente: beneficiarioNombre,
          slugEvento: normalizar(nombreProducto || descripcionProducto),
          nombreEvento: nombreProducto || descripcionProducto,
          descripcionProducto,
          direccionEvento,
          fechaActuacion
        });
      } catch {}
    }

    await enviarEmailConEntradas({
      email,
      nombre: beneficiarioNombre,
      entradas: buffers,
      descripcionProducto,
      importe: 0,
      facturaAdjunta: null
    });

    res.status(201).json({ ok: true, enviados: buffers.length, codigos, sheetId, formularioId });
  } catch (err) {
    console.error('crear-entrada-regalo:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
