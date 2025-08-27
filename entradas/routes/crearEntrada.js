// /entradas/routes/crearEntrada.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy'); // avisos al admin (proxy seguro)

/* ───────────────────── Seguridad / Flags ───────────────────── */
const API_KEY        = (process.env.ENTRADAS_API_KEY || '').trim();          // p.ej. L4bo_Entradas_xxx
const HMAC_SECRET    = (process.env.ENTRADAS_HMAC_SECRET || '').trim();      // 32+ bytes aleatorios
const LEGACY_TOKEN   = (process.env.FLUENTFORM_TOKEN || '').trim();          // compat opcional
const WINDOW_MS      = 5 * 60 * 1000;                                        // ±5 min
const ENTRADAS_DEBUG = String(process.env.ENTRADAS_DEBUG || '') === '1';     // logs extra
const REQUIRE_HMAC   = String(process.env.ENTRADAS_REQUIRE_HMAC || '0') === '1'; // forzar HMAC si 1
const IP_ALLOW       = String(process.env.ENTRADAS_IP_ALLOW || '')
  .split(',').map(s => s.trim()).filter(Boolean);                            // allowlist solo para legacy

/* ───────────────────── Utils seguridad ───────────────────── */
const seen = new Map(); // anti-replay en memoria: key = `${ts}.${sig}` → expiresAt

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
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || '';
}
function mask(s) {
  if (!s) return null;
  const str = String(s);
  return str.length <= 4 ? '••••' : `••••${str.slice(-4)}`;
}

/* ───────────────────── alertAdmin seguro ───────────────────── */
let warnedConfigMissing = false;
async function safeAlert(mensaje, extra = {}) {
  try {
    // Adaptado a la firma real: { area, email, err, meta }
    await alertAdmin({
      area: 'entradas.crear',
      email: String(extra.email || '-').toLowerCase(),
      err: new Error(String(mensaje)),
      meta: {
        contexto: 'entradas/routes/crearEntrada.js',
        ...extra,
      }
    });
  } catch { /* nunca romper el flujo por fallo de alertas */ }
}

/** Verifica HMAC: devuelve { ok:true, ts, bodyHash10, exp10, sig10 } si válido; si no, { ok:false, code, msg } */
function verifyHmac(req, expectedPath) {
  const apiKeyHdr = req.get('x-api-key');
  const ts        = req.get('x-entr-ts');
  const sig       = req.get('x-entr-sig');

  if (!API_KEY || !HMAC_SECRET) {
    if (ENTRADAS_DEBUG) console.warn('[ENTR HMAC FAIL] cfg-missing');
    if (!warnedConfigMissing) {
      warnedConfigMissing = true;
      safeAlert('❌ [Seguridad] Falta ENTRADAS_API_KEY o ENTRADAS_HMAC_SECRET en el servidor. HMAC inoperativo.', { severidad: 'ALTA' });
    }
    return { ok: false, code: 500, msg: 'Config incompleta' };
  }
  if (apiKeyHdr !== API_KEY)  return { ok: false, code: 401, msg: 'Unauthorized' };
  if (!/^\d+$/.test(ts || '')) return { ok: false, code: 401, msg: 'Unauthorized' };

  const tsNum = Number(ts);
  const now   = Date.now();
  if (Math.abs(now - tsNum) > WINDOW_MS) return { ok: false, code: 401, msg: 'Expired/Skew' };

  // Firmamos: ts.POST.<path>.sha256(body)
  const body     = req.rawBody ?? JSON.stringify(req.body ?? {});
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const base     = `${ts}.POST.${expectedPath}.${bodyHash}`;
  const expected = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');

  pruneSeen();
  const k = `${ts}.${sig}`;
  if (seen.has(k)) return { ok: false, code: 401, msg: 'Replay' };

  const ok = timingSafeEqualHex(expected, sig);
  if (!ok) {
    if (ENTRADAS_DEBUG) {
      console.warn('[ENTR HMAC FAIL] bad-signature', {
        path: expectedPath, ts,
        bodyHash10: bodyHash.slice(0, 10),
        exp10: expected.slice(0, 10),
        sig10: String(sig).slice(0, 10),
      });
    }
    return { ok: false, code: 401, msg: 'Bad signature' };
  }

  seen.set(k, now + WINDOW_MS);
  return {
    ok: true,
    ts,
    bodyHash10: bodyHash.slice(0, 10),
    exp10: expected.slice(0, 10),
    sig10: String(sig).slice(0, 10),
  };
}

/* Mantener rawBody (si no lo haces ya en app.use(express.json())) */
router.use((req, _res, next) => {
  if (typeof req.rawBody === 'string' && req.rawBody.length) return next();
  if (req.readable && !req.body) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => { req.rawBody = data || ''; next(); });
    req.on('error', () => { req.rawBody = ''; next(); });
  } else {
    try { req.rawBody = JSON.stringify(req.body || {}); }
    catch { req.rawBody = ''; }
    next();
  }
});

/* ───────────────────── Dedupe básica ───────────────────── */
const processed = new Set();

/* ───────────────────── Handler principal ───────────────────── */
router.post('/', async (req, res) => {
  // 1) Seguridad (preferente HMAC). La ruta firmada debe coincidir EXACTAMENTE
  // con la publicada por WP (sin /wp-json).
  const expectedPath = '/entradas/crear';
  const h = verifyHmac(req, expectedPath);

  if (h.ok) {
    // ✅ LOG IRREFUTABLE DE HMAC OK
    console.log('🛡️ [ENTR HMAC OK]', {
      ip: clientIp(req),
      ua: req.get('user-agent') || '',
      path: expectedPath,
      ts: h.ts,
      bodyHash10: h.bodyHash10,
      exp10: h.exp10,
      sig10: h.sig10,
      apiKeyMasked: mask(API_KEY),
    });
  } else {
    // Fallback legacy si NO exigimos HMAC
    const provided = okBearerOrRaw(req.headers.authorization);
    if (REQUIRE_HMAC) {
      console.warn('[ENTR HMAC FAIL][REQUIRE_HMAC=1]', h.msg || 'legacy disabled');
      // Aviso cuando se bloquea por HMAC obligatorio
      safeAlert('❌ HMAC inválido con REQUIRE_HMAC=1 (bloqueado)', {
        motivo: h.msg || 'bad hmac',
        ip: clientIp(req),
        ua: req.get('user-agent') || '',
        path: expectedPath,
      });
      return res.status(h.code || 401).json({ error: 'Unauthorized' });
    }
    if (!LEGACY_TOKEN || provided !== LEGACY_TOKEN) {
      console.warn('[ENTR SECURITY FAIL]', h.msg || 'legacy token mismatch');
      // Aviso por token legacy inválido
      safeAlert('⚠️ Intento con token legacy inválido', {
        motivo: h.msg || 'legacy token mismatch',
        ip: clientIp(req),
        ua: req.get('user-agent') || '',
        path: expectedPath,
      });
      return res.status(h.code || 403).json({ error: 'Token inválido' });
    }
    const ip = clientIp(req);
    if (IP_ALLOW.length && !IP_ALLOW.includes(ip)) {
      console.warn('[ENTR LEGACY BLOCKED IP]', { ip, allow: IP_ALLOW });
      // Aviso por IP bloqueada en modo legacy
      safeAlert('⚠️ IP no permitida en modo legacy', {
        ip,
        allow: IP_ALLOW,
        path: expectedPath,
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // ✅ LOG IRREFUTABLE DE LEGACY OK
    console.log('🟡 [ENTR LEGACY OK]', {
      ip,
      ua: req.get('user-agent') || '',
      authLen: provided.length,
      note: 'Se aceptó Authorization (modo compat).'
    });
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
    // aviso ALTA (bloquea generación)
    safeAlert('⚠️ Datos incompletos en /entradas/crear', {
      email,
      slugEvento: !!slugEvento,
      fechaEvento: !!fechaEvento,
      descripcionProducto: !!descripcionProducto,
      numEntradas: !!numEntradas,
    });
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
      await safeAlert('❌ Fallo crítico enviando email de entradas', {
        email,
        slugEvento,
        detalle: e?.message || String(e),
      });
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
        console.error('⚠️ No se pudo avisar al admin (email personalizado):', e.message || e);
      }
      // alerta discreta adicional
      safeAlert('⚠️ Errores no críticos en generarEntradas', {
        email,
        slugEvento,
        idFormulario,
        errores,
      });
    }

    console.log(`✅ Entradas generadas y enviadas a ${email} (${numEntradas})`);
    return res.status(200).json({ ok: true, mensaje: 'Entradas generadas y enviadas' });
  } catch (err) {
    console.error('❌ Error en /entradas/crear:', err.message || err);
    await safeAlert('❌ Error generando entradas', {
      email,
      slugEvento,
      detalle: err?.message || String(err),
    });
    return res.status(500).json({ error: 'Error generando entradas' });
  }
});

module.exports = router;
