// /entradas/routes/crear-entrada-regalo.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { generarCodigoEntrada, normalizar } = require('../utils/codigos');
const { subirEntrada } = require('../utils/gcsEntradas');
const { registrarEntradaFirestore } = require('../services/registrarEntradaFirestore');

const { google } = require('googleapis');
const { auth } = require('../google/sheetsAuth');

const router = express.Router();

/* ───────────────────── Config ───────────────────── */
const API_KEY        = (process.env.ENTRADAS_API_KEY || process.env.FLUENTFORM_TOKEN || '').trim();
const HMAC_SECRET    = (process.env.ENTRADAS_HMAC_SECRET || '').trim();
const SKEW_MS        = Number(process.env.ENTRADAS_SKEW_MS || 5 * 60 * 1000); // ±5 min
const ENTRADAS_DEBUG = String(process.env.ENTRADAS_DEBUG || '') === '1';

/* ───────────────────── Captura rawBody ─────────────────────
   MUY IMPORTANTE: firmamos/verificamos con el cuerpo EXACTO recibido. */
router.use((req, _res, next) => {
  if (typeof req.rawBody === 'string' && req.rawBody.length) return next();

  // Si aún no está parseado, leemos el stream para montar rawBody
  if (req.readable && !req.body) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => { req.rawBody = data || ''; next(); });
    req.on('error', () => { req.rawBody = ''; next(); });
  } else {
    // Si ya hay req.body, lo serializamos tal cual para tener un rawBody estable
    try { req.rawBody = JSON.stringify(req.body || {}); }
    catch { req.rawBody = ''; }
    next();
  }
});

/* ───────────────────── Seguridad ───────────────────── */
function verifyAuth(req) {
  // 1) API key: "x-api-key" o "Authorization: Bearer …"
  const bearer    = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const headerKey = (req.headers['x-api-key'] || '').trim();
  const providedKey = headerKey || bearer;

  if (!API_KEY || providedKey !== API_KEY) {
    return { ok: false, code: 403, msg: 'Unauthorized (key)' };
  }

  // 2) HMAC opcional (si hay secreto definido)
  if (!HMAC_SECRET) return { ok: true };

  // Acepta ambas variantes de cabeceras
  const tsHeader  = String(req.headers['x-e-ts']    || req.headers['x-entr-ts'] || '');
  const sigHeader = String(req.headers['x-e-sig']   || req.headers['x-entr-sig'] || '');

  if (!/^\d+$/.test(tsHeader) || !sigHeader) {
    return { ok: false, code: 401, msg: 'Missing HMAC headers' };
  }

  // Ventana temporal
  const now = Date.now();
  if (Math.abs(now - Number(tsHeader)) > SKEW_MS) {
    return { ok: false, code: 401, msg: 'Expired token' };
  }

  // Firmamos: ts.POST.<path>.sha256(body)
  const path     = (req.originalUrl || '').split('?')[0]; // sin query
  const bodyStr  = (typeof req.rawBody === 'string') ? req.rawBody : JSON.stringify(req.body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const base     = `${tsHeader}.POST.${path}.${bodyHash}`;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  let okSig = false;
  try {
    // Comparamos en tiempo constante
    okSig = expected.length === sigHeader.length &&
            crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sigHeader, 'utf8'));
  } catch { okSig = false; }

  if (ENTRADAS_DEBUG) {
    const mask = (s) => (s ? `••••${String(s).slice(-4)}` : null);
    console.log('[ENTRADAS DEBUG IN]', {
      path,
      ts: tsHeader,
      bodyHash10: bodyHash.slice(0, 10),
      sig10: sigHeader.slice(0, 10),
      exp10: expected.slice(0, 10),
      apiKeyMasked: mask(providedKey),
      headerVariant: req.headers['x-e-ts'] ? 'x-e-*' : (req.headers['x-entr-ts'] ? 'x-entr-*' : 'none')
    });
  }

  if (!okSig) return { ok: false, code: 401, msg: 'Bad signature' };
  return { ok: true };
}

/* ───────────────────── Config hojas ───────────────────── */
const MAP_SHEETS = {
  '22': process.env.SHEET_ID_FORM_22 || '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': process.env.SHEET_ID_FORM_39 || '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': process.env.SHEET_ID_FORM_40 || '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': process.env.SHEET_ID_FORM_41 || '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': process.env.SHEET_ID_FORM_42 || '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc',
};
const FALLBACK_22 = MAP_SHEETS['22'];

/* ───────────────────── Helpers evento ───────────────────── */
function getEventoFromEnv(formId) {
  const id = String(formId || '').trim();
  const env = (k) => process.env[k] || '';
  return {
    descripcionProducto: env(`EVENT_${id}_DESCRIPCION`) || env(`EVENT_${id}_DESC`) || '',
    nombreProducto:      env(`EVENT_${id}_NOMBRE`) || '',
    fechaActuacion:      env(`EVENT_${id}_FECHA`) || '',
    direccionEvento:     env(`EVENT_${id}_DIRECCION`) || '',
    imagenEvento:        env(`EVENT_${id}_IMG`) || env('EVENT_DEFAULT_IMG') || ''
  };
}
function getSheetId(formularioId) {
  const id = String(formularioId || '').trim();
  return MAP_SHEETS[id] || FALLBACK_22;
}

/* Inserta fila en A:G: A=fecha, B=desc, C=comprador, D=código, E="NO", F="NO", G="REGALO" */
async function appendRegaloRow({ spreadsheetId, fecha, desc, comprador, codigo }) {
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'A:G',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[fecha, desc, comprador, codigo, 'NO', 'NO', 'REGALO']] }
  });
}

/* ───────────────────── Ruta ───────────────────── */
const processed = new Set(); // dedupe básica en memoria

router.post('/crear-entrada-regalo', async (req, res) => {
  // Seguridad primero
  const authRes = verifyAuth(req);
  if (!authRes.ok) {
    console.warn('⛔️ /entradas/crear-entrada-regalo auth failed:', authRes.msg);
    return res.status(authRes.code).json({ ok: false, error: authRes.msg });
  }

  try {
    const beneficiarioNombre = String(req.body?.beneficiarioNombre || '').trim();
    const email              = String(req.body?.beneficiarioEmail || '').trim().toLowerCase();
    const cantidad           = Math.max(1, parseInt(req.body?.cantidad, 10) || 1);
    const formularioId       = String(req.body?.formularioId || '22').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email del beneficiario inválido' });
    }

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
      return res.status(400).json({ ok: false, error: 'Falta descripcionProducto (hidden o EVENT_{ID}_DESCRIPCION)' });
    }

    const sheetId = getSheetId(formularioId);
    const carpeta = normalizar(descripcionProducto);
    const fechaCompra = dayjs().utcOffset(120).format('DD/MM/YYYY - HH:mm') + 'h';

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
      facturaAdjunta: null,
      modo: 'regalo',
      fecha: fechaActuacion,
      direccion: direccionEvento
    });

    console.log(`✅ Entradas REGALO generadas y enviadas a ${email} (${buffers.length})`);
    res.status(201).json({ ok: true, enviados: buffers.length, codigos, sheetId, formularioId });
  } catch (err) {
    console.error('❌ /entradas/crear-entrada-regalo:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
