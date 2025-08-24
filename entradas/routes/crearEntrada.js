// /entradas/routes/crearEntrada.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

// ── Seguridad ─────────────────────────────────────────────────────────────
const API_KEY      = (process.env.ENTRADAS_API_KEY || '').trim();         // p.ej. L4bo_Entradas_xxx
const HMAC_SECRET  = (process.env.ENTRADAS_HMAC_SECRET || '').trim();     // 32+ bytes aleatorios
const LEGACY_TOKEN = (process.env.FLUENTFORM_TOKEN || '').trim();         // compat opcional (Authorization: Bearer …)
const WINDOW_MS    = 5 * 60 * 1000;                                       // ±5 min
const ENTRADAS_DEBUG = String(process.env.ENTRADAS_DEBUG || '') === '1';  // logs de verificación

// Anti-replay in-memory (usa Redis si puedes en producción)
const seen = new Map(); // key = `${ts}.${sig}` → expiresAt

function pruneSeen() {
  const now = Date.now();
  for (const [k, exp] of seen.entries()) if (exp <= now) seen.delete(k);
}

function timingSafeEqualHex(aHex, bHex) {
  try {
    const a = Buffer.from(String(aHex), 'hex');
    const b = Buffer.from(String(bHex), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function okBearerOrRaw(authHeader) {
  const v = String(authHeader || '');
  return v.startsWith('Bearer ') ? v.slice(7) : v;
}

function verifyHmac(req, expectedPath) {
  const apiKeyHdr = req.get('x-api-key');
  const ts        = req.get('x-entr-ts');
  const sig       = req.get('x-entr-sig');

  if (!API_KEY || !HMAC_SECRET) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] cfg-missing');
    return { ok: false, code: 500, msg: 'Config incompleta' };
  }
  if (apiKeyHdr !== API_KEY) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] bad-api-key');
    return { ok: false, code: 401, msg: 'Unauthorized' };
  }
  if (!/^\d+$/.test(ts || '')) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] bad-ts');
    return { ok: false, code: 401, msg: 'Unauthorized' };
  }

  const tsNum = Number(ts);
  const now   = Date.now();
  if (Math.abs(now - tsNum) > WINDOW_MS) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] expired/skew', { ts });
    return { ok: false, code: 401, msg: 'Expired/Skew' };
  }

  // Firmamos: ts.POST.<path>.sha256(body)
  const body     = req.rawBody ?? JSON.stringify(req.body ?? {});
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const base     = `${ts}.POST.${expectedPath}.${bodyHash}`;
  const expectedSig = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  // Anti-replay
  pruneSeen();
  const k = `${ts}.${sig}`;
  if (seen.has(k)) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] replay', { ts });
    return { ok: false, code: 401, msg: 'Replay' };
  }

  const ok = timingSafeEqualHex(expectedSig, sig);
  if (ok) {
    if (ENTRADAS_DEBUG) {
      console.log('[ENTR HMAC OK]', {
        path: expectedPath,
        ts,
        bodyHash10: bodyHash.slice(0, 10),
        sig10: String(sig).slice(0, 10)
      });
    }
    seen.set(k, now + WINDOW_MS);
    return { ok: true };
  } else {
    if (ENTRADAS_DEBUG) {
      console.warn('[ENTR HMAC FAIL] bad-signature', {
        path: expectedPath,
        ts,
        bodyHash10: bodyHash.slice(0, 10),
        exp10: expectedSig.slice(0, 10),
        sig10: String(sig).slice(0, 10)
      });
    }
    return { ok: false, code: 401, msg: 'Bad signature' };
  }
}

// Middleware seguro para disponer de req.rawBody aunque ya exista body-parser
router.use((req, _res, next) => {
  if (typeof req.rawBody === 'string' && req.rawBody.length) return next();
  if (req.readable && !req.body) {
    // No se ha parseado aún: capturamos stream
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => { req.rawBody = data || ''; next(); });
    req.on('error', () => { req.rawBody = ''; next(); });
  } else {
    // Ya parseado por express.json(): reconstruimos
    try { req.rawBody = JSON.stringify(req.body || {}); }
    catch { req.rawBody = ''; }
    next();
  }
});

// ── Dedupe básica de negocio ─────────────────────────────────────────────
const processed = new Set();

// Handler principal
router.post('/', async (req, res) => {
  // 1) Seguridad (preferente HMAC). La ruta firmada debe coincidir EXACTAMENTE
  // con la pública publicada por Node (sin /wp-json).
  const expectedPath = '/entradas/crear';
  const h = verifyHmac(req, expectedPath);

  // Fallback: token legado “Authorization: Bearer <FLUENTFORM_TOKEN>”
  if (h.ok) {
    if (ENTRADAS_DEBUG) console.log('[ENTR AUTH] method=hmac');
  } else {
    const provided = okBearerOrRaw(req.headers.authorization);
    if (!LEGACY_TOKEN || provided !== LEGACY_TOKEN) {
      console.warn('⛔️ Seguridad entradas fallida:', h.msg || 'legacy token mismatch');
      return res.status(h.code || 403).json({ error: 'Token inválido' });
    }
    if (ENTRADAS_DEBUG) console.log('[ENTR AUTH] method=legacy');
  }

  // 2) Parseo y validaciones
  const datos = req.body || {};
  const email = String(datos.email || datos.email_autorelleno || '').trim().toLowerCase();
  const nombre = String(datos.nombre || '').trim();
  const apellidos = String(datos.apellidos || '').trim();
  const asistentes = Array.isArray(datos.asistentes) ? datos.asistentes : [];
  const numEntradas = parseInt(datos.numeroEntradas || asistentes.length || 1, 10);
  const imagenFondo = String(datos.imagenFondoPDF || '').trim();
  const slugEvento = String(datos.nombreProducto || datos.slugEvento || '').trim();
  const fechaEvento = String(datos.fechaEvento || '').trim();
  const direccionEvento = String(datos.direccionEvento || '').trim();
  const descripcionProducto = String(datos.descripcionProducto || '').trim();
  const importe = parseFloat(String(datos.importe ?? '0').replace(',', '.')) || 0;
  const idFormulario = String(datos.formularioId || datos.formulario_id || '').trim();

  if (!email || !slugEvento || !fechaEvento || !descripcionProducto || !numEntradas) {
    console.warn('⚠️ Datos incompletos para crear entrada');
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  const hashUnico = `${email}-${slugEvento}-${numEntradas}-${importe}`;
  if (processed.has(hashUnico)) {
    console.warn(`⛔️ Solicitud duplicada ignorada para ${email}`);
    return res.status(200).json({ ok: true, mensaje: 'Duplicado ignorado' });
  }
  processed.add(hashUnico);

  try {
    // 3) Generar entradas
    const { entradas, errores } = await generarEntradas({
      email,
      nombre,
      apellidos,
      asistentes,
      numEntradas,
      slugEvento,
      fechaEvento,
      direccionEvento,
      descripcionProducto,
      imagenFondo,
      idFormulario
    });

    // 4) Enviar email SIEMPRE (si falla, respondemos 500)
    try {
      await enviarEmailConEntradas({
        email,
        nombre,
        entradas,
        facturaAdjunta: datos.facturaPdfBuffer || null,
        descripcionProducto,
        importe
      });
    } catch (e) {
      console.error('❌ Error enviando email de entradas:', e.message || e);
      return res.status(500).json({ error: 'No se pudo enviar el email con entradas.' });
    }

    // 5) Aviso admin si hubo errores no críticos
    if (errores?.length) {
      try {
        const { enviarEmailPersonalizado } = require('../../services/email');
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: `⚠️ Fallos post-pago en registro de entradas (${email})`,
          text: JSON.stringify({ email, descripcionProducto, fechaEvento, slugEvento, idFormulario, errores }, null, 2)
        });
      } catch (e) {
        console.error('⚠️ No se pudo avisar al admin:', e.message || e);
      }
    }

    console.log(`✅ Entradas generadas y enviadas a ${email} (${numEntradas})`);
    return res.status(200).json({ ok: true, mensaje: 'Entradas generadas y enviadas' });
  } catch (err) {
    console.error('❌ Error en /entradas/crear:', err.message || err);
    return res.status(500).json({ error: 'Error generando entradas' });
  }
});

module.exports = router;

