// 🔐 VALIDAR ENTRADA QR – Uso privado (Ignacio + 3 personas)
// POST /validar-entrada  (o /entradas/validar-entrada si montas el router con prefijo)
// Seguridad: x-api-key + HMAC (x-val-ts, x-val-sig) sobre ts.POST.<path>.sha256(body)
// Fallback opcional: X-LABOROTECA-TOKEN (desaconsejado; controlado por REQUIRE_HMAC)

'use strict';

const express = require('express');
const crypto  = require('crypto');
const admin   = require('../../firebase');
const firestore = admin.firestore();

const { marcarEntradaComoUsada } = require('../utils/sheetsEntradas');

const router = express.Router();

/* ===============================
   CONFIG SEGURIDAD
   =============================== */
const API_KEY          = (process.env.VALIDADOR_API_KEY || '').trim();            // p.ej. Val_Entradas_xxx
const HMAC_SECRET      = (process.env.VALIDADOR_HMAC_SECRET || '').trim();        // 32+ bytes
const SKEW_MS          = Number(process.env.VALIDADOR_SKEW_MS || 5*60*1000);      // ±5 min
const REQUIRE_HMAC     = String(process.env.VALIDADOR_REQUIRE_HMAC || '1') === '1';
const LEGACY_TOKEN     = (process.env.VALIDADOR_ENTRADAS_TOKEN || '').trim();     // compat (X-LABOROTECA-TOKEN)
const IP_ALLOW         = String(process.env.VALIDADOR_IP_ALLOW || '')
  .split(',').map(s => s.trim()).filter(Boolean);                                 // allowlist opcional
const RATE_PER_MIN     = Number(process.env.VALIDADOR_RATE_PER_MIN || 60);        // peticiones/min por IP
const MAX_BODY_BYTES   = Number(process.env.VALIDADOR_MAX_BODY || 12*1024);       // 12KB
const DEBUG            = String(process.env.VALIDADOR_DEBUG || '') === '1';

function maskTail(s){ return s ? `••••${String(s).slice(-4)}` : null; }

/* ===============================
   JSON parser + rawBody para HMAC
   =============================== */
router.use(express.json({
  limit: '20kb',
  verify: (req, _res, buf) => {
    // Guarda rawBody para el cálculo HMAC
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));

/* ===============================
   RATE LIMIT simple por IP (ventana 1 min)
   =============================== */
const rl = new Map(); // key=ip+minute → count
function clientIp(req){
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || '';
}
function rateLimit(req){
  const ip = clientIp(req);
  if (!ip) return true;
  const key = ip + '|' + new Date().toISOString().slice(0,16); // YYYY-MM-DDTHH:MM
  const count = (rl.get(key) || 0) + 1;
  rl.set(key, count);
  return count <= RATE_PER_MIN;
}

/* ===============================
   ANTI-REPLAY (nonce en memoria)
   =============================== */
const seen = new Map(); // key = ts.sig → expiresAt
function pruneSeen(){
  const now = Date.now();
  for (const [k, exp] of seen.entries()) if (exp <= now) seen.delete(k);
}

/* ===============================
   VERIFICACIÓN DE AUTORIZACIÓN
   =============================== */
function verifyAuth(req){
  // 0) Content-Type y tamaño
  if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) {
    return { ok:false, code:415, msg:'Content-Type inválido' };
  }
  const rawStr = req.rawBody ? (Buffer.isBuffer(req.rawBody)? req.rawBody.toString('utf8') : String(req.rawBody)) : '';
  if (Buffer.byteLength(rawStr, 'utf8') > MAX_BODY_BYTES) {
    return { ok:false, code:413, msg:'Payload demasiado grande' };
  }

  // 1) Allowlist IP (opcional)
  const ip = clientIp(req);
  if (IP_ALLOW.length && !IP_ALLOW.includes(ip)) {
    return { ok:false, code:401, msg:'IP no autorizada' };
  }

  // 2) Rate limit
  if (!rateLimit(req)) {
    return { ok:false, code:429, msg:'Too Many Requests' };
  }

  // 3) HMAC preferente
  const hdrKey = String(req.headers['x-api-key'] || '').trim();
  const ts     = String(req.headers['x-val-ts'] || req.headers['x-entr-ts'] || req.headers['x-e-ts'] || '');
  const sig    = String(req.headers['x-val-sig']|| req.headers['x-entr-sig']|| req.headers['x-e-sig']|| '');

  const haveHmacHeaders = API_KEY && HMAC_SECRET && ts && sig && hdrKey;

  if (haveHmacHeaders) {
    if (hdrKey !== API_KEY)  return { ok:false, code:401, msg:'Unauthorized (key)' };
    if (!/^\d+$/.test(ts))   return { ok:false, code:401, msg:'Unauthorized (ts)' };

    const now = Date.now();
    if (Math.abs(now - Number(ts)) > SKEW_MS) {
      return { ok:false, code:401, msg:'Expired/Skew' };
    }

    const seenPath = new URL(req.originalUrl, 'http://x').pathname; // p.ej. /entradas/validar-entrada
    const bodyHash = crypto.createHash('sha256').update(rawStr, 'utf8').digest('hex');
    const candidates = [
      seenPath,                       // path real que ve Express
      '/validar-entrada',             // sin prefijo
      '/entradas/validar-entrada'     // con prefijo
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let ok = false;
    let chosenPath = '';
    let expected = '';

    for (const p of candidates) {
      const base = `${ts}.POST.${p}.${bodyHash}`;
      const exp  = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
      try {
        const a = Buffer.from(exp, 'utf8');
        const b = Buffer.from(sig, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          ok = true;
          chosenPath = p;
          expected = exp;
          break;
        }
      } catch {/* ignore */}
    }

    if (DEBUG) {
      console.log('[VALIDADOR DEBUG IN]', {
        ip,
        path_seen: seenPath,
        chosen_path: chosenPath || null,
        ts,
        bodyHash10: bodyHash.slice(0,10),
        sig10: String(sig).slice(0,10),
        exp10: expected ? expected.slice(0,10) : null,
        apiKeyMasked: maskTail(API_KEY)
      });
    }

    if (!ok) return { ok:false, code:401, msg:'Bad signature' };

    // anti-replay
    pruneSeen();
    const nonceKey = ts + '.' + String(sig).slice(0,16);
    if (seen.has(nonceKey)) return { ok:false, code:401, msg:'Replay' };
    seen.set(nonceKey, now + SKEW_MS);

    return { ok:true, mode:'HMAC' };
  }

  // 4) Fallback legacy solo si NO exigimos HMAC
  if (!REQUIRE_HMAC) {
    const legacy = String(req.headers['x-laboroteca-token'] || '').trim();
    if (legacy && LEGACY_TOKEN && legacy === LEGACY_TOKEN) {
      if (DEBUG) console.log('[VALIDADOR LEGACY OK]', { ip, note:'X-LABOROTECA-TOKEN' });
      return { ok:true, mode:'LEGACY' };
    }
  }

  return { ok:false, code:401, msg:'Unauthorized' };
}

/* ===============================
   NORMALIZACIÓN CÓDIGO
   =============================== */
function limpiarCodigoEntrada(input){
  let c = String(input || '').trim();
  if (!c) return '';
  if (/^https?:\/\//i.test(c)) {
    try {
      const url = new URL(c);
      c = url.searchParams.get('codigo') || c;
    } catch { /* usar tal cual */ }
  }
  c = c.replace(/\s+/g,'').toUpperCase();
  // evita inputs claramente rotos
  if (c.includes('//') || c.length > 80) return '';
  return c;
}

/* ============================================================
 *  HANDLER
 * ============================================================ */
router.post('/validar-entrada', async (req, res) => {
  // Seguridad
  const auth = verifyAuth(req);
  if (!auth.ok) {
    if (DEBUG) console.warn('⛔️ /validar-entrada auth failed:', auth.msg);
    return res.status(auth.code || 401).json({ error: 'Unauthorized' });
  }

  try {
    const slugEventoRaw = String(req.body?.slugEvento || '').trim();
    const codigoLimpio  = limpiarCodigoEntrada(req.body?.codigoEntrada);

    if (!codigoLimpio || !slugEventoRaw) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    // (Opcional) whitelist de slugs para eventos activos, vía ENV
    const SLUG_ALLOW = String(process.env.VALIDADOR_SLUG_ALLOW || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (SLUG_ALLOW.length && !SLUG_ALLOW.includes(slugEventoRaw)) {
      return res.status(401).json({ error: 'Evento no autorizado.' });
    }

    // Evita revalidaciones: Firestore
    const docRef  = firestore.collection('entradasValidadas').doc(codigoLimpio);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      return res.status(409).json({ error: 'Entrada ya validada.' });
    }

    // Buscar y marcar en Sheets
    const resultado = await marcarEntradaComoUsada(codigoLimpio, slugEventoRaw);
    if (!resultado || resultado.error) {
      return res.status(404).json({ error: resultado?.error || 'Código no encontrado.' });
    }

    const { emailComprador, nombreAsistente } = resultado;

    // Permite trazar quién valida (si el proxy WP lo envía)
    const validadorEmail = String(req.body?.validadorEmail || '').trim() || null;
    const validadorWpId  = Number(req.body?.validadorWpId || 0) || null;

    await docRef.set({
      validado: true,
      fechaValidacion: new Date().toISOString(),
      validador: validadorEmail || 'Ignacio',
      validadorWpId: validadorWpId,
      emailComprador: emailComprador || null,
      nombreAsistente: nombreAsistente || null,
      evento: codigoLimpio.split('-')[0] || '',
      slugEvento: slugEventoRaw,
      authMode: auth.mode || 'HMAC'
    });

    if (DEBUG) console.log(`✅ Entrada ${codigoLimpio} validada correctamente (modo ${auth.mode}).`);
    return res.json({ ok: true, mensaje: 'Entrada validada correctamente.' });

  } catch (err) {
    console.error('❌ Error en /validar-entrada:', err?.stack || err);
    return res.status(500).json({ error: 'Error interno al validar entrada.' });
  }
});

module.exports = router;
