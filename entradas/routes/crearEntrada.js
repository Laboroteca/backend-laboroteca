// /entradas/routes/crearEntrada.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

// ── Seguridad ─────────────────────────────────────────────────────────────
const API_KEY = (process.env.ENTRADAS_API_KEY || '').trim();           // p.ej. L4bo_Entradas_xxx
const HMAC_SECRET = (process.env.ENTRADAS_HMAC_SECRET || '').trim();   // 32+ bytes aleatorios
const LEGACY_TOKEN = (process.env.FLUENTFORM_TOKEN || '').trim();      // compat opcional
const WINDOW_MS = 5 * 60 * 1000;

// Anti-replay in-memory (si tienes Redis/ensureOnce, úsalo ahí)
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
  const ts = req.get('x-entr-ts');
  const sig = req.get('x-entr-sig');

  if (!API_KEY || !HMAC_SECRET) return { ok: false, code: 500, msg: 'Config incompleta' };
  if (apiKeyHdr !== API_KEY)    return { ok: false, code: 401, msg: 'Unauthorized' };
  if (!/^\d+$/.test(ts || ''))  return { ok: false, code: 401, msg: 'Unauthorized' };

  const tsNum = Number(ts);
  const now = Date.now();
  if (Math.abs(now - tsNum) > WINDOW_MS) return { ok: false, code: 401, msg: 'Expired/Skew' };

  // Firmamos: ts.POST.<path>.sha256(body)
  const body = req.rawBody ?? JSON.stringify(req.body ?? {});
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const base = `${ts}.POST.${expectedPath}.${bodyHash}`;
  const expectedSig = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  // Anti-replay
  const k = `${ts}.${sig}`;
  pruneSeen();
  if (seen.has(k)) return { ok: false, code: 401, msg: 'Replay' };

  if (!timingSafeEqualHex(expectedSig, sig)) return { ok: false, code: 401, msg: 'Bad signature' };

  seen.set(k, now + WINDOW_MS);
  return { ok: true };
}

// Middleware para conservar rawBody (necesario si no lo tienes ya a nivel app)
router.use((req, _res, next) => {
  if (req.rawBody) return next();
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (data += chunk));
  req.on('end', () => {
    try { req.rawBody = data || JSON.stringify(req.body || {}); } catch { req.rawBody = data || ''; }
    next();
  });
});

// ── Dedupe básica de negocio ─────────────────────────────────────────────
const processed = new Set();

router.post('/', async (req, res) => {
  // 1) Seguridad (preferente HMAC). Ruta firmada debe coincidir EXACTAMENTE:
  // usa el path público con /wp-json en el emisor; aquí usamos el path real del endpoint Node.
  const expectedPath = '/entradas/crear'; // <-- ajusta si cambias la ruta real publicada
  const h = verifyHmac(req, expectedPath);

  // Fallback: token legado “Authorization: Bearer <FLUENTFORM_TOKEN>”
  if (!h.ok) {
    const provided = okBearerOrRaw(req.headers.authorization);
    if (!LEGACY_TOKEN || provided !== LEGACY_TOKEN) {
      console.warn('⛔️ Seguridad entradas fallida:', h.msg || 'legacy token mismatch');
      return res.status(h.code || 403).json({ error: 'Token inválido' });
    }
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
