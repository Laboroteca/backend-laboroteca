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

// ── Config de eventos (se nutre igual que el flujo de pago)
const MAP_SHEETS = {
  '22': process.env.SHEET_ID_FORM_22 || '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': process.env.SHEET_ID_FORM_39 || '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': process.env.SHEET_ID_FORM_40 || '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': process.env.SHEET_ID_FORM_41 || '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': process.env.SHEET_ID_FORM_42 || '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc',
};
const FALLBACK_22 = MAP_SHEETS['22'];

// ⚙️ Datos del evento tal y como vendrían en session.metadata del flujo de pago
const EVENT_CONFIG = {
  '22': {
    descripcionProducto: 'Evento 1',
    fechaActuacion: '30/10/2025 - 17:00',
    direccionEvento: 'Dirección evento 1',
    imagenEvento: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-qr-scaled.jpg',
    nombreProducto: 'Evento 1'
  },
  '39': {
    descripcionProducto: 'Evento 2',
    fechaActuacion: '31/10/2025 - 19:00',
    direccionEvento: 'Dirección evento 2',
    imagenEvento: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-qr-scaled.jpg',
    nombreProducto: 'Evento 2'
  },
  '40': { descripcionProducto: 'Evento 3', fechaActuacion: '', direccionEvento: '', imagenEvento: '', nombreProducto: 'Evento 3' },
  '41': { descripcionProducto: 'Evento 4', fechaActuacion: '', direccionEvento: '', imagenEvento: '', nombreProducto: 'Evento 4' },
  '42': { descripcionProducto: 'Evento 5', fechaActuacion: '', direccionEvento: '', imagenEvento: '', nombreProducto: 'Evento 5' }
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
  // colorear G
  const m = (resp.data?.updates?.updatedRange || '').match(/([A-Z]+)(\d+):/);
  if (m) {
    const row1 = parseInt(m[2], 10);
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetIdNum = meta.data.sheets?.[0]?.properties?.sheetId || 0;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{
        repeatCell: {
          range: { sheetId: sheetIdNum, startRowIndex: row1 - 1, endRowIndex: row1, startColumnIndex: 6, endColumnIndex: 7 },
          cell: { userEnteredFormat: { backgroundColor: COLOR_ROSA, textFormat: TEXTO_BOLD } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]}
    });
  }
}

/**
 * POST /entradas/crear-entrada-regalo
 * body: { beneficiarioNombre, beneficiarioEmail, cantidad, formularioId }
 */
router.post('/crear-entrada-regalo', async (req, res) => {
  try {
    const beneficiarioNombre = String(req.body?.beneficiarioNombre || '').trim();
    const email = String(req.body?.beneficiarioEmail || '').trim().toLowerCase();
    const cantidad = Math.max(1, parseInt(req.body?.cantidad, 10) || 1);
    const formularioId = String(req.body?.formularioId || '22').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ ok: false, error: 'Email del beneficiario inválido' });

    const cfg = EVENT_CONFIG[formularioId] || EVENT_CONFIG['22'];
    const sheetId = getSheetId(formularioId);
    const carpeta = normalizar(cfg.descripcionProducto || cfg.nombreProducto || 'evento');
    const fechaCompra = dayjs().format('DD/MM/YYYY - HH:mm');

    const buffers = [];
    const codigos = [];

    for (let i = 0; i < cantidad; i++) {
      const codigo = generarCodigoEntrada(normalizar(cfg.nombreProducto || cfg.descripcionProducto || 'EVT'));
      const pdf = await generarEntradaPDF({
        nombre: beneficiarioNombre,
        apellidos: '',
        codigo,
        nombreActuacion: cfg.nombreProducto || cfg.descripcionProducto,
        fechaActuacion: cfg.fechaActuacion,
        descripcionProducto: cfg.descripcionProducto,
        direccionEvento: cfg.direccionEvento,
        imagenFondo: cfg.imagenEvento
      });
      buffers.push({ buffer: pdf });
      codigos.push(codigo);

      // GCS (best-effort)
      try { await subirEntrada(`entradas/${carpeta}/${codigo}.pdf`, pdf); } catch {}

      // Sheets (G="REGALO")
      try {
        await appendRegaloRow({
          spreadsheetId: sheetId,
          fecha: fechaCompra,
          desc: cfg.descripcionProducto,
          comprador: email,
          codigo
        });
      } catch {}

      // Firestore
      try {
        await registrarEntradaFirestore({
          codigoEntrada: codigo,
          emailComprador: email,
          nombreAsistente: beneficiarioNombre,
          slugEvento: normalizar(cfg.nombreProducto || cfg.descripcionProducto),
          nombreEvento: cfg.nombreProducto || cfg.descripcionProducto,
          descripcionProducto: cfg.descripcionProducto,
          direccionEvento: cfg.direccionEvento,
          fechaActuacion: cfg.fechaActuacion
        });
      } catch {}
    }

    // Email al beneficiario con las entradas
    await enviarEmailConEntradas({
      email,
      nombre: beneficiarioNombre,
      entradas: buffers,
      descripcionProducto: cfg.descripcionProducto,
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
