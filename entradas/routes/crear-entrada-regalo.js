// /entradas/routes/crear-entrada-regalo.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { generarCodigoEntrada, normalizar } = require('../utils/codigos');
const { subirEntrada } = require('../utils/gcsEntradas');
const { registrarEntradaFirestore } = require('../services/registrarEntradaFirestore');

const { google } = require('googleapis');
const { auth } = require('../google/sheetsAuth');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const router = express.Router();

/* ───────────────────── Config ───────────────────── */
const API_KEY        = (process.env.ENTRADAS_API_KEY || process.env.FLUENTFORM_TOKEN || '').trim();
const HMAC_SECRET    = (process.env.ENTRADAS_HMAC_SECRET || '').trim();
const SKEW_MS        = Number(process.env.ENTRADAS_SKEW_MS || 5 * 60 * 1000); // ±5 min
const ENTRADAS_DEBUG = String(process.env.ENTRADAS_DEBUG || '') === '1';

// Log de comprobación de secreto (hash, no el valor)
if (ENTRADAS_DEBUG) {
  try {
    const sha10 = crypto.createHash('sha256').update(HMAC_SECRET || '', 'utf8').digest('hex').slice(0, 10);
    console.log('[ENTR SECRET NODE]', { sha10 });
  } catch {}
}

/* ───────────────────── Captura rawBody ─────────────────────
   Firmamos/verificamos con el cuerpo EXACTO recibido. */
router.use((req, _res, next) => {
  if (typeof req.rawBody === 'string' && req.rawBody.length) return next();

  if (req.readable && !req.body) {
    let data = '';
    try { req.setEncoding('utf8'); } catch {}
    req.on('data', chunk => (data += chunk));
    req.on('end',  () => { req.rawBody = data || ''; next(); });
    req.on('error', () => { req.rawBody = ''; next(); });
  } else {
    try { req.rawBody = JSON.stringify(req.body || {}); }
    catch { req.rawBody = ''; }
    next();
  }
});

/* ───────────────────── Seguridad ───────────────────── */
function verifyAuth(req) {
  // 1) API key: "x-api-key" o "Authorization: Bearer …"
  const bearer      = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const headerKey   = (req.headers['x-api-key'] || '').trim();
  const providedKey = headerKey || bearer;
  if (!API_KEY || providedKey !== API_KEY) {
    return { ok: false, code: 403, msg: 'Unauthorized (key)' };
  }

  // 2) HMAC opcional (si hay secreto definido)
  if (!HMAC_SECRET) return { ok: true };

  // Aceptar ambas variantes de cabeceras
  const tsHeader  = String(req.headers['x-e-ts']  || req.headers['x-entr-ts']  || '');
  const sigHeader = String(req.headers['x-e-sig'] || req.headers['x-entr-sig'] || '');
  if (!/^\d+$/.test(tsHeader) || !sigHeader) {
    return { ok: false, code: 401, msg: 'Missing HMAC headers' };
  }

  // Ventana temporal
  const now = Date.now();
  if (Math.abs(now - Number(tsHeader)) > SKEW_MS) {
    return { ok: false, code: 401, msg: 'Expired token' };
  }

  // Path sin query
  const path = (req.originalUrl || '').split('?')[0];

  // Calculamos DOS hashes posibles del body y aceptamos si cualquiera cuadra
  const rawStr  = (typeof req.rawBody === 'string') ? req.rawBody : '';
  const jsonStr = (() => { try { return JSON.stringify(req.body || {}); } catch { return ''; } })();

  const bodyHashRaw  = rawStr  ? crypto.createHash('sha256').update(rawStr,  'utf8').digest('hex') : null;
  const bodyHashJson = jsonStr ? crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex') : null;

  const baseRaw  = bodyHashRaw  ? `${tsHeader}.POST.${path}.${bodyHashRaw}`  : null;
  const baseJson = bodyHashJson ? `${tsHeader}.POST.${path}.${bodyHashJson}` : null;

  const expRaw  = baseRaw  ? crypto.createHmac('sha256', HMAC_SECRET).update(baseRaw).digest('hex')  : null;
  const expJson = baseJson ? crypto.createHmac('sha256', HMAC_SECRET).update(baseJson).digest('hex') : null;

  let okSig = false;
  let matchedVariant = 'none';
  try {
    if (expRaw && expRaw.length === sigHeader.length &&
        crypto.timingSafeEqual(Buffer.from(expRaw, 'utf8'), Buffer.from(sigHeader, 'utf8'))) {
      okSig = true; matchedVariant = 'raw';
    } else if (expJson && expJson.length === sigHeader.length &&
        crypto.timingSafeEqual(Buffer.from(expJson, 'utf8'), Buffer.from(sigHeader, 'utf8'))) {
      okSig = true; matchedVariant = 'json';
    }
  } catch { okSig = false; }

  if (ENTRADAS_DEBUG) {
    const mask = (s) => (s ? `••••${String(s).slice(-4)}` : null);

    // Log de la base (para comparar con WP sin exponer secretos)
    console.log('[ENTR BASE NODE]', {
      ts: tsHeader,
      path,
      bodyHash10_raw:  bodyHashRaw  ? bodyHashRaw.slice(0,10)  : null,
      bodyHash10_json: bodyHashJson ? bodyHashJson.slice(0,10) : null,
      base10_raw:  baseRaw  ? baseRaw.slice(0,10)  : null,
      base10_json: baseJson ? baseJson.slice(0,10) : null,
      sig10: sigHeader.slice(0,10)
    });

    console.log('[ENTRADAS DEBUG IN]', {
      path,
      ts: tsHeader,
      sig10: sigHeader.slice(0, 10),
      exp10_raw:  expRaw  ? expRaw.slice(0, 10)  : null,
      exp10_json: expJson ? expJson.slice(0, 10) : null,
      matched: matchedVariant,
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
    try {
      await alertAdmin({
        area: 'entradas.regalo.auth',
        email: String(req.body?.beneficiarioEmail || '-').toLowerCase(),
        err: new Error(authRes.msg),
        meta: {
          ip: req.ip,
          path: req.originalUrl || '',
          headerVariant: req.headers['x-e-ts'] ? 'x-e-*' : (req.headers['x-entr-ts'] ? 'x-entr-*' : 'none')
        }
      });
    } catch (_) {}
    return res.status(authRes.code).json({ ok: false, error: authRes.msg });
  }

  try {
    const beneficiarioNombre = String(req.body?.beneficiarioNombre || '').trim();
    const email              = String(req.body?.beneficiarioEmail || '').trim().toLowerCase();
    const cantidad           = Math.max(1, parseInt(req.body?.cantidad, 10) || 1);
    const formularioId       = String(req.body?.formularioId || '22').trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      try {
        await alertAdmin({
          area: 'entradas.regalo.validacion',
          email: String(req.body?.beneficiarioEmail || '-').toLowerCase(),
          err: new Error('Email del beneficiario inválido'),
          meta: { formularioId, bodyKeys: Object.keys(req.body || {}) }
        });
      } catch (_) {}
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
      try {
        await alertAdmin({
          area: 'entradas.regalo.validacion',
          email,
          err: new Error('Falta descripcionProducto'),
          meta: { formularioId, nombreProducto, envCfg: true }
        });
      } catch (_) {}
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

      try { await subirEntrada(`entradas/${carpeta}/${codigo}.pdf`, pdf); }
      catch (e) {
        try {
          await alertAdmin({
            area: 'entradas.regalo.gcs',
            email,
            err: e,
            meta: { codigo, carpeta, descripcionProducto, nombreProducto, formularioId, accion: 'subirEntrada' }
          });
        } catch (_) {}
      }

      try {
        await appendRegaloRow({
          spreadsheetId: sheetId,
          fecha: fechaCompra,
          desc: descripcionProducto,
          comprador: email,
          codigo
        });
      } catch (e) {
        try {
          await alertAdmin({
            area: 'entradas.regalo.sheets',
            email,
            err: e,
            meta: { codigo, sheetId, formularioId, descripcionProducto, fechaCompra, accion: 'appendRegaloRow' }
          });
        } catch (_) {}
      }

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
      } catch (e) {
        try {
          await alertAdmin({
            area: 'entradas.regalo.firestore',
            email,
            err: e,
            meta: { codigo, formularioId, slug: normalizar(nombreProducto || descripcionProducto), accion: 'registrarEntradaFirestore' }
          });
        } catch (_) {}
      }
    }

    try {
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
    } catch (e) {
      try {
        await alertAdmin({
          area: 'entradas.regalo.email',
          email,
          err: e,
          meta: { enviados: buffers.length, codigos, formularioId, descripcionProducto, accion: 'enviarEmailConEntradas' }
        });
      } catch (_) {}
      throw e; // mantener comportamiento original (propaga al catch general)
    }

    console.log(`✅ Entradas REGALO generadas y enviadas a ${email} (${buffers.length})`);
    res.status(201).json({ ok: true, enviados: buffers.length, codigos, sheetId, formularioId });
  } catch (err) {
    console.error('❌ /entradas/crear-entrada-regalo:', err?.message || err);
    try {
      await alertAdmin({
        area: 'entradas.regalo.route',
        email: String(req.body?.beneficiarioEmail || '-').toLowerCase(),
        err: err,
        meta: {
          formularioId: String(req.body?.formularioId || '22').trim(),
          descripcionProducto: String(req.body?.descripcionProducto || '').trim(),
          codigos: typeof codigos !== 'undefined' ? codigos : undefined
        }
      });
    } catch (_) {}
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
