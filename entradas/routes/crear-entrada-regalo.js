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

// ── Hoja por formulario (fallback al 22)
const MAP_SHEETS = {
  '22': process.env.SHEET_ID_FORM_22 || '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': process.env.SHEET_ID_FORM_39 || '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': process.env.SHEET_ID_FORM_40 || '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': process.env.SHEET_ID_FORM_41 || '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': process.env.SHEET_ID_FORM_42 || '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc',
};
const FALLBACK_22 = MAP_SHEETS['22'];

// ── Lee metadatos del evento desde variables de entorno por formulario
//    Soportados (ej. para form 39):
//      EVENT_39_DESCRIPCION  | EVENT_39_DESC
//      EVENT_39_NOMBRE
//      EVENT_39_FECHA
//      EVENT_39_DIRECCION
//      EVENT_39_IMG
//    Opcional global: EVENT_DEFAULT_IMG
function getEventoFromEnv(formId) {
  const id = String(formId || '').trim();
  const env = (k) => process.env[k] || '';
  return {
    descripcionProducto:
      env(`EVENT_${id}_DESCRIPCION`) || env(`EVENT_${id}_DESC`) || '',
    nombreProducto:
      env(`EVENT_${id}_NOMBRE`) || '',
    fechaActuacion:
      env(`EVENT_${id}_FECHA`) || '',
    direccionEvento:
      env(`EVENT_${id}_DIRECCION`) || '',
    imagenEvento:
      env(`EVENT_${id}_IMG`) || env('EVENT_DEFAULT_IMG') || ''
  };
}

// ── Estilos: Columna G "REGALO"
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
            range: {
              sheetId: sheetIdNum,
              startRowIndex: row1 - 1,
              endRowIndex: row1,
              startColumnIndex: 6, // G
              endColumnIndex: 7
            },
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
 * body:
 *   beneficiarioNombre, beneficiarioEmail, cantidad, formularioId
 *   (opcionalmente puede enviar: descripcionProducto, nombreProducto, fechaActuacion, direccionEvento, imagenEvento)
 */
router.post('/crear-entrada-regalo', async (req, res) => {
  try {
    const beneficiarioNombre = String(req.body?.beneficiarioNombre || '').trim();
    const email              = String(req.body?.beneficiarioEmail || '').trim().toLowerCase();
    const cantidad           = Math.max(1, parseInt(req.body?.cantidad, 10) || 1);
    const formularioId       = String(req.body?.formularioId || '22').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email del beneficiario inválido' });
    }

    // 1) Preferimos SIEMPRE lo que envía el frontend (hidden del formulario)
    // 2) Si no llegan, usamos ENV por formulario
    const envCfg = getEventoFromEnv(formularioId);

    const descripcionProducto = String(
      (req.body?.descripcionProducto !== undefined ? req.body.descripcionProducto : envCfg.descripcionProducto)
    ).trim();

    const nombreProducto = String(
      (req.body?.nombreProducto !== undefined ? req.body.nombreProducto : envCfg.nombreProducto || descripcionProducto)
    ).trim();

    const fechaActuacion = String(
      (req.body?.fechaActuacion !== undefined ? req.body.fechaActuacion : envCfg.fechaActuacion)
    ).trim();

    const direccionEvento = String(
      (req.body?.direccionEvento !== undefined ? req.body.direccionEvento : envCfg.direccionEvento)
    ).trim();

    const imagenEvento = String(
      (req.body?.imagenEvento !== undefined ? req.body.imagenEvento : envCfg.imagenEvento)
    ).trim();

    if (!descripcionProducto) {
      return res.status(400).json({ ok: false, error: 'Falta descripcionProducto (envía hidden o define EVENT_{ID}_DESCRIPCION)' });
    }

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
