if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// ───────────────────────────────────────────────────────────
// GCP creds desde Base64 → GOOGLE_APPLICATION_CREDENTIALS
// (solo si aún no está definida)
try {
  if (process.env.GCP_CREDENTIALS_BASE64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fs = require('fs');
    const path = '/tmp/gcp_sa.json';
    fs.writeFileSync(path, Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64'));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
    console.log('✅ GOOGLE_APPLICATION_CREDENTIALS => /tmp/gcp_sa.json (desde GCP_CREDENTIALS_BASE64)');
  }
} catch (e) {
  console.error('❌ Error inicializando GOOGLE_APPLICATION_CREDENTIALS:', e?.message || e);
}
// ───────────────────────────────────────────────────────────

const { alertAdminProxy: alertAdmin } = require('./utils/alertAdminProxy');

// Utilidad para no mostrar claves en claro
const crypto = require('crypto');
const hash8 = v => v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0,8) : 'MISSING';
const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
// 🔒 flag global para obligar HMAC en endpoints duros
const REQUIRE_HMAC = (process.env.LAB_REQUIRE_HMAC === '1');

// 🔑 Seguridad de endpoints de pago
const PAGO_API_KEY = String(process.env.PAGO_API_KEY || '').trim();
const PAGO_HMAC_SECRET = String(process.env.PAGO_HMAC_SECRET || '').trim();

console.log('🧠 INDEX REAL EJECUTÁNDOSE');
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔑 STRIPE_SECRET_KEY presente:', !!process.env.STRIPE_SECRET_KEY);
console.log('🔐 STRIPE_WEBHOOK_SECRET presente:', !!process.env.STRIPE_WEBHOOK_SECRET);
console.log('🔒 MP_SYNC_HMAC_SECRET presente:', !!process.env.MP_SYNC_HMAC_SECRET);
console.log('🔒 LAB_ELIM_HMAC_SECRET presente:', !!process.env.LAB_ELIM_HMAC_SECRET);
console.log('🧷 LAB_REQUIRE_HMAC activo:', REQUIRE_HMAC);
console.log('🔑 PAGO_API_KEY presente:', !!PAGO_API_KEY);
console.log('🔒 PAGO_HMAC_SECRET presente:', !!PAGO_HMAC_SECRET);
console.log('🔒 RISK_HMAC_SECRET presente:', !!process.env.RISK_HMAC_SECRET);
console.log('🔒 WP_RISK_ENDPOINT presente:', !!process.env.WP_RISK_ENDPOINT);
console.log('🔒 WP_RISK_SECRET presente:', !!process.env.WP_RISK_SECRET);
console.log('🔒 LAB_BAJA_HMAC_SECRET presente:', !!process.env.LAB_BAJA_HMAC_SECRET);
console.log('🔑 MKT_API_KEY presente:', !!process.env.MKT_API_KEY);
console.log('🔒 MKT_CONSENT_SECRET presente:', !!process.env.MKT_CONSENT_SECRET);

// Log seguro de MemberPress (sin exponer la clave)
console.log('🛠 MemberPress config:');
console.log('   📍 SITE_URL =', process.env.SITE_URL || '(no set)');
console.log('   🔑 MEMBERPRESS_KEY =', process.env.MEMBERPRESS_KEY ? `present (${hash8(process.env.MEMBERPRESS_KEY)})` : 'MISSING');

if (!process.env.STRIPE_SECRET_KEY) {
  try {
  alertAdmin({
    area: 'startup_env_missing',
    email: '-',
    err: new Error('Falta STRIPE_SECRET_KEY'),
    meta: { hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET, nodeEnv: process.env.NODE_ENV }
  }).catch(() => {});
} catch (_) {}
  throw new Error('❌ Falta STRIPE_SECRET_KEY en variables de entorno');
}
if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('❌ Falta STRIPE_WEBHOOK_SECRET en producción');
}

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fetch = require('node-fetch');
const { eliminarUsuarioWordPress } = require('./services/eliminarUsuarioWordPress');
const procesarCompra = require('./services/procesarCompra');
const { activarMembresiaClub } = require('./services/activarMembresiaClub');
const { syncMemberpressClub } = require('./services/syncMemberpressClub');
// ▶️ Rutas de señales de riesgo (WP ↔ Node con HMAC)
const riskEvents = require('./routes/risk-events');
// 🆕 Catálogo unificado (resolver + datos + imagen)
const {
  PRODUCTOS,
  resolverProducto,
  normalizarProducto: normalizarProductoCat,
  getImagenProducto,
  DEFAULT_IMAGE
} = require('./utils/productos');
const desactivarMembresiaClubForm = require('./routes/desactivarMembresiaClub');
const desactivarMembresiaClub = require('./services/desactivarMembresiaClub');
// ✔️ HMAC para baja voluntaria (WP → Backend)
const { verifyHmac } = require('./utils/verifyHmac');
const WP_ASSERTED_SENTINEL = process.env.WP_ASSERTED_SENTINEL || '__WP_ASSERTED__';
// 👈 BAJA usa su propio secreto (no el de MP sync)
const BAJA_HMAC_SECRET = (process.env.LAB_BAJA_HMAC_SECRET || '').trim();
const validarEntrada = require('./entradas/routes/validarEntrada');
const crearCodigoRegalo = require('./regalos/routes/crear-codigo-regalo');
const registrarConsentimiento = require('./routes/registrar-consentimiento');
const marketingConsent = require('./routes/marketing-consent');
const marketingUnsubscribe = require('./routes/marketing-unsubscribe');
const marketingSend = require('./routes/marketing-send');
const marketingCron = require('./routes/marketing-cron');
const { jobBajasScheduler: cronBajasClub } = require('./jobs/stripe_bajasClub_planB');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// 🟢 LOGGER ULTRA-TEMPRANO (antes de helmet/cors/ratelimit/body-parsers)
app.use((req, _res, next) => {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  console.log('→', req.method, req.originalUrl, '| ct:', ct || '(none)', '| ip:', ip);
  next();
});

// util solo para logs de depuración (no imprime secretos completos)
function _first10Sha256(str) {
  try { return crypto.createHash('sha256').update(String(str),'utf8').digest('hex').slice(0,10); }
  catch { return 'errhash'; }
}

const _fallbackSeen = new Map();
function _fallbackGc(){ const now=Date.now(); for (const [k,exp] of _fallbackSeen) if (exp<=now) _fallbackSeen.delete(k); }


// ─────────────────────────────────────
// Seguridad HTTP y rendimiento (PROD)
// ─────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false // dejamos CSP gestionado por WP / frontend
}));
app.use(compression());

// Rate-limit global suave (además de los específicos)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.GLOBAL_RL_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(globalLimiter);

// 🔒 Rate limit específico para /risk (WP ↔ Node)
const riskLimiter = rateLimit({
  windowMs: Number(process.env.RISK_RL_WINDOW_MS || 60 * 1000), // 1 min
  max: Number(process.env.RISK_RL_MAX || 60),                   // 60 req/min
  standardHeaders: true,
  legacyHeaders: false
});

// ── MW de cierre para pagos (POST + API KEY + HMAC opcional según flag global) ─────────────
function enforcePost(req,res,next){
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });
  next();
}

 function requireApiKeyPago(req,res,next){
   // Si exigimos HMAC globalmente, el HMAC basta (API key opcional)
   if (REQUIRE_HMAC) return next();
   if (!PAGO_API_KEY) return res.status(500).json({ ok:false, error:'PAGO_API_KEY_MISSING' });
   const key = String(req.headers['x-api-key'] || '').trim();
   if (key !== PAGO_API_KEY) {
     if (LAB_DEBUG) console.warn('⛔ API KEY inválida en %s (hasKey=%s)', req.path, !!key);
     return res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
   }
   return next();
 }

function requireHmacPago(req,res,next){
  if (!REQUIRE_HMAC) return next();
  if (!PAGO_HMAC_SECRET) return res.status(500).json({ ok:false, error:'PAGO_HMAC_SECRET_MISSING' });
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  let v = verifyHmac({
    method: 'POST',
    path: req.path,
    bodyRaw: raw,
    headers: req.headers,
    secret: PAGO_HMAC_SECRET
  });
  if (LAB_DEBUG) {
    const ts = String(req.headers['x-lab-ts'] || req.headers['x_lb_ts'] || '');
    const sig = String(req.headers['x-lab-sig'] || req.headers['x_lb_sig'] || '');
    console.log('[PAGO HMAC IN]', {
      path: req.path,
      ts,
      bodySha256_10: _first10Sha256(raw),
      sig10: sig.slice(0,10),
      ok: !!v.ok,
      err: v.ok ? '-' : v.error
    });
  }
  // Si OK, continuamos
  if (v.ok) return next();

  
  // 🛟 Fallbacks por "skew": aceptar sin 401 si el TS venía en ms
  if (String(v.error || '').toLowerCase() === 'skew') {
    try {
      const tsHeader = String(req.headers['x-lab-ts'] || req.headers['x_lb_ts'] || '');
      const sigHeader = String(req.headers['x-lab-sig'] || req.headers['x_lb_sig'] || '');
      const tsNum = Number(tsHeader);
      const tsSec = (tsNum > 1e11) ? Math.floor(tsNum / 1000) : tsNum; // ms → s si hace falta
      const nowSec = Math.floor(Date.now() / 1000);
      const maxSkew = Number(process.env.LAB_HMAC_SKEW_SECS || 900); // 15 min por defecto
      const rawHash = require('crypto').createHash('sha256').update(Buffer.from(raw,'utf8')).digest('hex');

      // a) LEGACY: ts.sha256(body)
      const expectLegacy = require('crypto')
        .createHmac('sha256', PAGO_HMAC_SECRET)
        .update(`${tsSec}.${rawHash}`).digest('hex');

      // b) V2 (bridge): ts.POST.<path>.sha256(body)
      const expectV2 = require('crypto')
        .createHmac('sha256', PAGO_HMAC_SECRET)
        .update(`${tsSec}.POST.${req.path}.${rawHash}`).digest('hex');

      const within = Math.abs(nowSec - tsSec) <= maxSkew;
      if (within && (sigHeader === expectLegacy || sigHeader === expectV2)) {
        if (LAB_DEBUG) {
          console.warn('[PAGO HMAC] aceptado por fallback skew',
            { match: sigHeader === expectLegacy ? 'legacy' : 'v2', path: req.path });
        }
        // Anti-replay en camino de fallback
        const reqIdHdr = String(req.headers['x-request-id'] || req.headers['x_request_id'] || '');
        if (reqIdHdr) {
          _fallbackGc();
          if (_fallbackSeen.has(reqIdHdr)) {
            return res.status(409).json({ ok:false, error:'REPLAY' });
          }
          _fallbackSeen.set(reqIdHdr, Date.now() + (maxSkew * 1000));
        }
        return next();
      }
    } catch (_) { /* noop */ }
  }
  // Si llegamos aquí, sigue siendo inválido
  return res.status(401).json({ ok:false, error:'HMAC_INVALID', detail: v.error });
}

app.use((req, _res, next) => {
  if (req.headers.origin) console.log('🌐 Origin:', req.headers.origin);
  next();
});

const allowProd = [
  'https://laboroteca.es',
  'https://www.laboroteca.es'
];
const allowDev = [
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
  'http://127.0.0.1:3000'
];
const extra = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ORIGINS = [
  ...allowProd,
  ...(process.env.NODE_ENV === 'production' ? [] : allowDev),
  ...extra
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    console.warn('⛔ CORS rechazado para:', origin);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-LABOROTECA-TOKEN',
    // HMAC headers para validador
    'x-api-key','x-val-ts','x-val-sig',
    'x-entr-ts','x-entr-sig',
    'x-e-ts','x-e-sig',
    // HMAC del panel Newsletter
    'x-lb-ts','x-lb-sig',
    // HMAC Baja Club (WP → Backend)
    'x-lab-ts','x-lab-sig','x-request-id',
    // HMAC Riesgo (WP → Backend)
    'x-risk-ts','x-risk-sig',
    // Bridge interno para /marketing/consent
    'x-internal-bridge',
    // Cron key para /marketing/cron-send
    'x-cron-key',
    // auditoría opcional del bridge
    'x-bridge'
  ],
  credentials: false, // pon true solo si usas cookies/sesión
  exposedHeaders: ['X-HMAC-Checked'] // 👈 permite leer esta cabecera en el cliente
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ⚠️ WEBHOOK: SIEMPRE EL PRIMERO Y EN RAW 
app.use('/webhook', require('./routes/webhook'));

// ⬇️ IMPORTANTE: capturamos rawBody para HMAC global
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf || '');
    try {
      const crypto = require('crypto');
      req.rawBodySha256 = crypto.createHash('sha256').update(req.rawBody).digest('hex');
    } catch (_) {}
  }
}));
app.use(express.urlencoded({ extended: true }));

// 🎯 Marketing necesita rawBody exacto para firmas WP
app.use('/marketing', express.json({
  limit: '5mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf || '');
  }
}));

// ─────────────────────────────────────
// Middleware: exigir JSON puro en rutas críticas
// ─────────────────────────────────────
function requireJson(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
  }
  return next();
}

// ───────────────────────────────────────────────────────────
// BRIDGE: /pago/bridge  (WP/Fluent Forms → Backend firmado)
// - Añade x-api-key + HMAC y reenvía a /crear-sesion-pago o
//   /crear-suscripcion-club según el caso.
// - Firma principal: ts.POST.<path>.sha256(body)  ✅
// - Fallback automático: ts.sha256(body)          🛟
// ───────────────────────────────────────────────────────────
app.post('/pago/bridge', requireJson, async (req, res) => {
  const API_KEY = PAGO_API_KEY;
  const HSEC    = PAGO_HMAC_SECRET;
  const BASE    = String(process.env.PUBLIC_BASE_URL || 'https://laboroteca-production.up.railway.app').replace(/\/+$/,'');

  try {
    if (!API_KEY || !HSEC) {
      return res.status(500).json({ ok:false, error:'PAGO_BRIDGE_MISCONFIG' });
    }

    // Decide destino
    const force = String(req.query.t || '').toLowerCase(); // 'suscripcion' | 'pago' | ''
    const body  = req.body || {};
    const isSubs = force === 'suscripcion'
      || /suscrip/i.test(String(body?.tipoProducto || ''))
      || /club/i.test(String(body?.nombreProducto || ''));

    const targetPath = isSubs ? '/crear-suscripcion-club' : '/crear-sesion-pago';
    const target  = `${BASE}${targetPath}`;

    // Bytes crudos
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const rawHash = require('crypto').createHash('sha256').update(raw).digest('hex');
    const ts  = Math.floor(Date.now()/1000);

    // Firma correcta (la que espera verifyHmac de pagos)
    const msgV2 = `${ts}.POST.${targetPath}.${rawHash}`;
    const sigV2 = require('crypto').createHmac('sha256', HSEC).update(msgV2).digest('hex');

    // ID de trazabilidad
    const reqId = `pg_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;

    if (LAB_DEBUG) {
      console.log('🟢 [/pago/bridge] → %s ts=%s hash10=%s sig10=%s',
        targetPath, ts, rawHash.slice(0,10), sigV2.slice(0,10));
    }

    // Helper para enviar
    const doFetch = async (sig, note) => {
      const controller = new (require('abort-controller'))();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': API_KEY,
            'x-lab-ts': String(ts),
            'x-lab-sig': sig,
            'x-request-id': reqId,
            'x-bridge': `wp:${note}` // pista de auditoría
          },
          body: raw,
          signal: controller.signal
        });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = { ok:false, error:'NON_JSON_RESPONSE', _raw:text?.slice(0,200) }; }
        if (LAB_DEBUG) console.log('🟢 [/pago/bridge] OUT %s → %s %s', targetPath, r.status, data?.error || 'ok');
        return { r, data };
      } finally {
        clearTimeout(timer);
      }
    };

    // 1) Intento con firma correcta (v2)
    let { r, data } = await doFetch(sigV2, 'v2');
    // 2) Fallback si el servidor responde HMAC_INVALID
    if (r.status === 401 && (data?.error === 'HMAC_INVALID' || data?.detail === 'HMAC_INVALID')) {
      const msgV1 = `${ts}.${rawHash}`; // legacy
      const sigV1 = require('crypto').createHmac('sha256', HSEC).update(msgV1).digest('hex');
      if (LAB_DEBUG) console.warn('🛟 [/pago/bridge] Reintentando con firma legacy…');
      ({ r, data } = await doFetch(sigV1, 'v1fallback'));
    }

    return res.status(r.status).json(data);
  } catch (e) {
    console.error('❌ pago/bridge ERROR:', e?.message || e);
    try { await alertAdmin({ area:'pago_bridge', email: req.body?.email || '-', err: e }); } catch(_){}
    return res.status(500).json({ ok:false, error:'BRIDGE_ERROR' });
  }
});


// ───────────────────────────────────────────────────────────
// BRIDGE: /marketing/consent-bridge (Fluent Forms sin HMAC)
// - Requiere x-api-key válida
// - Reenvía a la URL pública firmando HMAC (MKT_CONSENT_SECRET)
// - Logs claros de ida y vuelta + timeout
// Requiere: PUBLIC_BASE_URL=https://laboroteca-production.up.railway.app
// ───────────────────────────────────────────────────────────
app.post('/marketing/consent-bridge', requireJson, async (req, res) => {
  // ⚙️ Normaliza claves (quita comillas, BOM/ZW chars, trim)
  const clean = (v) => String(v || '')
    .trim()
    .replace(/^[\'"]|[\'"]$/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, ''); // ZWSP/ZWNJ/ZWJ/BOM

  const API_KEY = clean(process.env.MKT_API_KEY);
  const HSEC    = clean(process.env.MKT_CONSENT_SECRET);
  const BASE    = String(process.env.PUBLIC_BASE_URL || 'https://laboroteca-production.up.railway.app').replace(/\/+$/,'');
  const target  = `${BASE}/marketing/consent`;

  try {
    const ip  = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const ua  = (req.headers['user-agent'] || '').slice(0,180);
    // admite header x-api-key o Authorization: Bearer
    const rawHdr = req.headers['x-api-key'] || req.headers['x_api_key'] || '';
    const rawAuth = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? (req.headers['authorization'] || '').slice(7)
      : '';
    const apiKeyIn = clean(rawHdr || rawAuth);
    const body = req.body || {};

    console.log('🟢 [/marketing/consent-bridge] IN ip=%s ua=%s keys=%s',
      ip, ua, Object.keys(body||{}).join(','));


    // 🔍 Debug seguro de claves: hash y longitud (sin exponer valores)
    try {
      const h8 = v => require('crypto').createHash('sha256').update(String(v)).digest('hex').slice(0,8);
      console.log('🔑 [/marketing/consent-bridge] key chk:', {
        hasHdr: !!rawHdr || !!rawAuth,
        hasEnv: !!process.env.MKT_API_KEY,
        in_h8: h8(apiKeyIn), env_h8: h8(API_KEY),
        len_in: apiKeyIn.length, len_env: API_KEY.length
      });
    } catch(_) {}

    // API KEY de entrada (la que pone Fluent Forms), tras normalizar
    if (!API_KEY || apiKeyIn !== API_KEY) {
      console.warn('⛔ bridge UNAUTHORIZED: header hasKey=%s matches=%s', !!apiKeyIn, apiKeyIn===API_KEY);
    }

    // Validación mínima
    const email = String(body.email || '').toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok:false, error:'EMAIL_REQUIRED' });
    }

    // Firmar HMAC para el router real
    const ts  = Math.floor(Date.now()/1000);
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const rawHash = require('crypto').createHash('sha256').update(raw).digest('hex');
    const sig = require('crypto').createHmac('sha256', HSEC).update(`${ts}.${rawHash}`).digest('hex');

    // Forward a la URL pública (evita loopback y middlewares locales)
    const controller = new (require('abort-controller'))();
    const BRIDGE_TIMEOUT_MS = Number(process.env.MKT_BRIDGE_TIMEOUT_MS || 30000);
    const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);

    let r, text = '';
    try {
      r = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'x-lb-ts': String(ts),
          'x-lb-sig': sig,
          // pista al backend (opcional)
          'x-bridge': 'wp',
          'x-forwarded-for': ip,
          'user-agent': ua
        },
        body: raw,
        signal: controller.signal
      });
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }

    let data;
    try { data = JSON.parse(text); }
    catch { data = { ok:false, error:'NON_JSON_RESPONSE', _raw:text?.slice(0,200) }; }

    console.log('🟢 [/marketing/consent-bridge] OUT status=%s ok=%s error=%s',
      r.status, data?.ok, data?.error || '-');

    return res.status(r.status).json(data);
  } catch (e) {
    const code = /aborted/i.test(String(e?.message)) ? 504 : 500;
    console.error('❌ consent-bridge ERROR:', e?.message || e);
    try { await alertAdmin({ area:'marketing_consent_bridge', email: req.body?.email || '-', err: e }); } catch(_){}
    return res.status(code).json({ ok:false, error:'BRIDGE_ERROR' });
  }
});


// ───────────────────────────────────────────────────────────

// 🔒 Rate limit específico para canje (5 req/min por IP)
const canjearLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});

// 🔒 Rate limit específico para entradas (5 req/min por IP)
const entradasLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones de entradas. Inténtalo en 1 minuto.' },
  handler: (req, res, next, options) => {
    console.warn(`🚧 Rate limit /entradas para IP ${req.ip}`);
    res.status(options.statusCode).json(options.message);
  }
});

// 🔒 Rate limit específico para REENVÍO de entradas (más controlado)
// Ajustable por entorno: REENVIO_RL_WINDOW_MS y REENVIO_RL_MAX
const reenvioLimiter = rateLimit({
  windowMs: Number(process.env.REENVIO_RL_WINDOW_MS || 10 * 60 * 1000), // 10 min
  max: Number(process.env.REENVIO_RL_MAX || 12), // por IP en ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de reenvío. Inténtalo más tarde.' }
});

// 🔒 Rate limit para acciones de cuenta (evitar abuso)
// Ajustable por entorno: ACCOUNT_RL_WINDOW_MS y ACCOUNT_RL_MAX
const accountLimiter = rateLimit({
  windowMs: Number(process.env.ACCOUNT_RL_WINDOW_MS || 60 * 60 * 1000), // 1 h
  max: Number(process.env.ACCOUNT_RL_MAX || 10), // por IP en ventana
  standardHeaders: true,
  legacyHeaders: false
});

// 🔒 Rate limit específico para marketing (altas/bajas newsletter)
const marketingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,              // 5 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes a marketing. Inténtalo más tarde.' }
});

// NUEVO: ruta para registrar consentimiento (vía /api/…)
app.use('/api', registrarConsentimiento);
console.log('📌 Ruta de consentimientos montada en /api/registrar-consentimiento');

// NUEVO: rutas de riesgo (montadas bajo /risk)
app.use('/risk', riskLimiter, riskEvents); // RL + router (endpoints: /risk/login-ok, /risk/close-all, /risk/ping)
console.log('📌 Rutas de riesgo montadas en /risk (login-ok, close-all, ping)');

// 📩 Newsletter / Marketing (consent + unsubscribe)
app.use('/marketing', marketingLimiter, marketingConsent);
app.use('/marketing', marketingLimiter, marketingUnsubscribe);
// 👇 CRON de envíos programados (Railway hará POST /marketing/cron-send con cabecera x-cron-key)
app.use('/marketing', marketingLimiter, marketingCron);
app.use('/marketing', marketingLimiter, marketingSend);
console.log('📌 Rutas de marketing: /marketing/consent, /marketing/unsubscribe, /marketing/cron-send, /marketing/send-newsletter');
console.log('🔐 Recuerda definir MKT_CRON_KEY en Railway (service LABOROTECA).');
console.log('📌 Ruta de envío newsletter montada en /marketing/send-newsletter');

// DESPUÉS DEL WEBHOOK, LOS BODY PARSERS
app.use(require('./routes/solicitarEliminacionCuenta'));
app.use(require('./routes/confirmarEliminaciondecuenta'));
// --- Regalos ---
const canjearRouter = require('./regalos/routes/canjear-codigo');
// el router YA expone /regalos/canjear-codigo y /regalos/canjear-codigo-regalo
app.use('/regalos', canjearLimiter, canjearRouter);

app.use('/regalos', canjearLimiter, require('./regalos/routes/crear-codigo-regalo'));


// ⚠️ Aplica ANTES de montar routers que sirvan /entradas/reenviar
app.use('/entradas/reenviar', reenvioLimiter);

app.use('/entradas/crear', entradasLimiter, require('./entradas/routes/crearEntrada'));
app.use('/entradas/sesion', entradasLimiter, require('./entradas/routes/create-session-entrada'));
app.use('/entradas', entradasLimiter, require('./entradas/routes/crear-entrada-regalo'));
app.use('/', entradasLimiter, require('./entradas/routes/micuentaEntradas'));

app.use('/', validarEntrada); // /validar-entrada (el router HMAC ya tolera ambos paths)

const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

// (nota) ya importamos desde arriba resolverProducto/PRODUCTOS

async function verificarEmailEnWordPress(email) {
  console.log('🔓 Verificación desactivada. Email:', email);
  return true;
}

app.get('/', (req, res) => {
  res.send('✔️ API de Laboroteca activa');
});

// 🧪 Salud rápida para comprobar que el proceso vive y recibe
app.get('/_ping', (req, res) => res.json({ ok:true, ts: Date.now() }));


// ÚNICO handler con MW de cierre:
app.post(
  '/crear-sesion-pago',
  enforcePost,
  requireJson,
  pagoLimiter,
  // Primero HMAC (si LAB_REQUIRE_HMAC=1), luego API key (si LAB_REQUIRE_HMAC=0)
  requireHmacPago,
  requireApiKeyPago,
  async (req, res) => {
  const datos = req.body;
  console.log('📥 Datos recibidos en /crear-sesion-pago:\n', JSON.stringify(datos, null, 2));

  const email = (typeof datos.email_autorelleno === 'string' && datos.email_autorelleno.includes('@'))
    ? datos.email_autorelleno.trim().toLowerCase()
    : (typeof datos.email === 'string' && datos.email.includes('@') ? datos.email.trim().toLowerCase() : '');

  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';
  const descripcionProducto = datos.descripcionProducto || '';
  const precio = parseFloat((datos.importe || '29.90').toString().replace(',', '.'));


  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  if (!nombre || !email || !nombreProducto || !precio || isNaN(precio)) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o datos inválidos.' });
  }

  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', (email||'').replace(/^(.{0,2}).*(@.*\.)(.{0,3})$/, '$1***@***$2***'));
    return res.status(400).json({ error: 'Email inválido' });
  }

  // 🧭 Resolver producto del catálogo (prioriza price_id si existe)
  const productoResuelto = resolverProducto(
    { tipoProducto, nombreProducto, descripcionProducto, price_id: datos.price_id, priceId: datos.priceId },
    [] // no hay lineItems aún
  );

  // Nombre/descripcion/imagen “canon” si el catálogo lo conoce (derivado SIEMPRE del catálogo)
  const nombreProductoCanon = (productoResuelto?.nombre || nombreProducto || '').toString().trim();
  const descripcionCanon    = (productoResuelto?.descripcion || descripcionProducto || '').toString().trim();
  // Imagen: primero catálogo, si no → helper con fallback global
  const slugCanon           = productoResuelto?.slug || null;
  const imagenCanon         = slugCanon ? getImagenProducto(slugCanon)
                                        : (productoResuelto?.imagen || null);
  // Stripe line_items: usar price (price_id) del catálogo si existe y es VÁLIDO (activo y no recurrente).
  const candidatePriceId = String((productoResuelto?.price_id || productoResuelto?.priceId || '')).trim();
  let usarPriceId = false;
  // Importe de fallback (del formulario o del catálogo)
  let amountCents = Number.isFinite(precio) ? Math.round(precio * 100)
                    : (Number(productoResuelto?.precio_cents) || 0);
  if (candidatePriceId.startsWith('price_')) {
    try {
      // expandimos product para saber si ya tiene imagen en Stripe
      const pr = await stripe.prices.retrieve(candidatePriceId, { expand: ['product'] });
      const productHasImage = Array.isArray(pr?.product?.images) && pr.product.images.length > 0;
      // Solo usamos price si está activo, no recurrente **y** tiene imagen propia
      usarPriceId = !!(pr && pr.id && pr.active && !pr.recurring && productHasImage);
      if (!usarPriceId) {
        console.warn('⚠️ price_id no válido para pago único:', candidatePriceId, { active: pr?.active, recurring: !!pr?.recurring });
        if (typeof pr?.unit_amount === 'number') amountCents = pr.unit_amount; // respeta importe configurado si existe
      }
    } catch (e) {
      console.warn('⚠️ price_id inexistente/inaccesible en Stripe. Fallback a price_data:', candidatePriceId, e?.message || e);
    }
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    return res.status(403).json({ error: 'Este email no está registrado.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_creation: 'always',
      customer_email: email,
      line_items: usarPriceId
        ? [{
            // ✅ Usa el Price de catálogo (importe/imagen ya los tiene el producto Stripe)
            price: candidatePriceId,
            quantity: 1
          }]
        : [{
            // ✅ Fallback totalmente alimentado por utils/productos.js
            price_data: {
              currency: 'eur',
              unit_amount: amountCents,
              product_data: {
                name: nombreProductoCanon || 'Producto Laboroteca',
                description: descripcionCanon || undefined,
                // MUY IMPORTANTE: nutrimos la imagen desde el catálogo
                images: (imagenCanon ? [imagenCanon] : [])
              }
            },
            quantity: 1
          }],
      metadata: {
        nombre,
        apellidos,
        email,
        email_autorelleno: email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        // 🧾 metadatos “canon” para el resolver del backend
        nombreProducto: nombreProductoCanon,
        descripcionProducto: descripcionCanon,
        // 💳 ayuda al resolver por price_id en el backend
        price_id: productoResuelto?.price_id || productoResuelto?.priceId || '',
        // 🔗 pista de catálogo (no rompe nada si falta)
        slug: slugCanon || ''
      },
      success_url: `https://www.laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProductoCanon)}`,
      cancel_url: 'https://www.laboroteca.es/error'
    });

    return res.json({ url: session.url });
    } catch (error) {
      console.error('❌ Error Stripe (crear-sesion-pago):', error.message || error);
      console.error('❌ Error completo:', error);
      try {
        await alertAdmin({
          area: 'stripe_crear_sesion_pago_error',
          email: (req.body?.email_autorelleno || req.body?.email || '-').toLowerCase(),
          err: error,
          meta: {
            tipoProducto: req.body?.tipoProducto || '',
            nombreProducto: req.body?.nombreProducto || '',
            importe: req.body?.importe || null
          }
        });
      } catch (_) {}

    return res.status(500).json({ error: 'Error al crear el pago' });
    }
});


// Igual para suscripción: aplicar MW de cierre
app.post(
  '/crear-suscripcion-club',
  enforcePost,
  requireJson,
  pagoLimiter,
  requireHmacPago,
  requireApiKeyPago,
  async (req, res) => {
  const datos = req.body;

  const email = (typeof datos.email_autorelleno === 'string' && datos.email_autorelleno.includes('@'))
    ? datos.email_autorelleno.trim().toLowerCase()
    : (typeof datos.email === 'string' && datos.email.includes('@') ? datos.email.trim().toLowerCase() : '');

  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';
  const descripcionProducto = datos.descripcionProducto || '';
  const precio = parseFloat((datos.importe || '9.99').toString().replace(',', '.'));


  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  if (!nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', (email||'').replace(/^(.{0,2}).*(@.*\.)(.{0,3})$/, '$1***@***$2***'));
    return res.status(400).json({ error: 'Email inválido' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    return res.status(403).json({ error: 'Este email no está registrado.' });
  }

  // 🧭 Para el Club, usa siempre el price_id del catálogo
  const CLUB = PRODUCTOS['el-club-laboroteca'] || PRODUCTOS['el_club_laboroteca'] || PRODUCTOS['club laboroteca'];
  const clubPriceId = CLUB?.price_id || null;


  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: clubPriceId
        ? [{
            // ✅ precio oficial del Club (evita desajustes de importe/renovación)
            price: clubPriceId,
            quantity: 1
          }]
        : [{
            // fallback por si faltase price_id en env
            price_data: {
              currency: 'eur',
              product_data: { name: nombreProducto },
              unit_amount: Math.round(precio * 100),
              recurring: { interval: 'month' }
            },
            quantity: 1
          }],
      metadata: {
        nombre,
        apellidos,
        email,
        email_autorelleno: email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto: CLUB?.nombre || nombreProducto,
        descripcionProducto: descripcionProducto || CLUB?.descripcion || '',
        price_id: clubPriceId || ''
      },
      success_url: `https://www.laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent((CLUB?.nombre || nombreProducto))}`,
      cancel_url: 'https://www.laboroteca.es/error'
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error Stripe (crear-suscripcion-club):', error.message);
    try {
      await alertAdmin({
        area: 'stripe_crear_suscripcion_error',
        email: (req.body?.email_autorelleno || req.body?.email || '-').toLowerCase(),
        err: error,
        meta: {
          nombreProducto: req.body?.nombreProducto || '',
          importe: req.body?.importe || null
        }
      });
    } catch (_) {}

    return res.status(500).json({ error: 'Error al crear la suscripción' });
  }
});

app.post('/activar-membresia-club', accountLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    await activarMembresiaClub(email);
    await syncMemberpressClub({ email, accion: 'activar' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error activar membresía:', error.message);
    try {
      await alertAdmin({
        area: 'activar_membresia_club_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});


app.options('/cancelar-suscripcion-club', cors(corsOptions));

app.post('/cancelar-suscripcion-club', cors(corsOptions), requireJson, accountLimiter, async (req, res) => {
  // Si vienen cabeceras HMAC desde WP, usamos el flujo nuevo (sin password)
  const ts = String(req.headers['x-lab-ts'] || '');
  const sig = String(req.headers['x-lab-sig'] || '');
  const reqId = String(req.headers['x-request-id'] || '');
  const hasHmac = !!ts || !!sig || !!reqId;

  try {
    let resultado;
    let email;
    let via = 'legacy';
    // Path EXACTO (sin query) para que coincida con lo que firma WP
    const pathname = new URL(req.originalUrl || req.url, 'http://x').pathname;

    if (hasHmac) {
      if (!BAJA_HMAC_SECRET) {
        return res.status(500).json({ cancelada:false, mensaje:'Config HMAC ausente' });
      }
      // Verificar HMAC: ts.POST.<path>.sha256(body)
      if (LAB_DEBUG) {
        const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body||{});
        const bodyHash10 = _first10Sha256(raw);
        console.log('[BAJA HMAC IN]', { path: pathname, ts, bodyHash10, sig10: String(sig).slice(0,10), reqId });
        // 🔎 (opcional de depuración) imprime los tres componentes que deben casar con WP
        try {
          const fullHash = require('crypto').createHash('sha256').update(raw,'utf8').digest('hex');
          console.log('[BAJA HMAC CHECK]', { ts, path: pathname, bodyHash10: fullHash.slice(0,10) });
        } catch (_) {}
      }
      let v = verifyHmac({
        method: 'POST',
        path: pathname,
        bodyRaw: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
        headers: req.headers,
        secret: BAJA_HMAC_SECRET
      });
      // 🛟 Fallback por skew (ms→s) y doble formato (legacy|v2) igual que en pagos
      if (!v.ok && String(v.error || '').toLowerCase() === 'skew') {
        try {
          const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
          const rawHash = require('crypto').createHash('sha256').update(Buffer.from(raw,'utf8')).digest('hex');
          const tsHeader = String(req.headers['x-lab-ts'] || '');
          const sigHeader = String(req.headers['x-lab-sig'] || '');
          const tsNum = Number(tsHeader);
          const tsSec = (tsNum > 1e11) ? Math.floor(tsNum / 1000) : tsNum; // ms → s si hace falta
          const nowSec = Math.floor(Date.now() / 1000);
          const maxSkew = Number(process.env.LAB_HMAC_SKEW_SECS || 900);
          const within = Math.abs(nowSec - tsSec) <= maxSkew;
          const expectLegacy = require('crypto').createHmac('sha256', BAJA_HMAC_SECRET)
            .update(`${tsSec}.${rawHash}`).digest('hex');
          const expectV2 = require('crypto').createHmac('sha256', BAJA_HMAC_SECRET)
            .update(`${tsSec}.POST.${pathname}.${rawHash}`).digest('hex');
          if (within && (sigHeader === expectLegacy || sigHeader === expectV2)) {
            if (LAB_DEBUG) console.warn('[BAJA HMAC] aceptado por fallback skew', { match: (sigHeader===expectLegacy?'legacy':'v2'), path: pathname });
            v = { ok: true };
          }
        } catch(_) {}
      }
      if (!v.ok) {
        if (LAB_DEBUG) console.warn('[BAJA HMAC FAIL]', v.error, { reqId, ts, sig10: String(sig).slice(0,10) });
        return res.status(401).json({ cancelada:false, mensaje:'Auth HMAC inválida', error: v.error });
      }
      email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ cancelada:false, mensaje:'Email inválido' });
      }
      // Log inequívoco (aunque LAB_DEBUG=0) de que se usó HMAC
      console.log('[BAJA HMAC USED]', { reqId, email });
      if (LAB_DEBUG) console.log('[BAJA HMAC OK]', { reqId, email });
      via = 'hmac';
      // Llamada al servicio con SENTINEL (saltamos verificación de contraseña)
      resultado = await desactivarMembresiaClub(email, WP_ASSERTED_SENTINEL);
    } else {
      if (REQUIRE_HMAC) {
        return res.status(401).json({ cancelada:false, mensaje:'HMAC requerido (LAB_REQUIRE_HMAC=1)' });
      }
      // Compatibilidad: flujo antiguo (email + password desde cliente)
      if (LAB_DEBUG) console.log('[BAJA LEGACY IN] (sin HMAC)');
      email = (req.body && req.body.email) ? String(req.body.email).trim().toLowerCase() : '';
      const password = String((req.body || {}).password || '');
      if (!email || !password) {
        return res.status(400).json({ cancelada:false, mensaje:'Faltan datos obligatorios' });
      }
      resultado = await desactivarMembresiaClub(email, password);
    }

    // ❌ Si el objeto resultado indica fallo en validación
    if (!resultado.ok) {
      console.warn('⚠️ Cancelación bloqueada:', resultado.mensaje);
      const mensaje = resultado.mensaje === 'Contraseña incorrecta'
        ? 'Contraseña incorrecta'
        : 'No se pudo completar la cancelación: ' + resultado.mensaje;
      return res.status(401).json({
        cancelada: false,
        mensaje
      });
    }

    // ✅ Si se ha cancelado correctamente
    if (resultado.cancelada === true) {
      const ahoraISO = new Date().toISOString();
      // (Solo informativo en la respuesta; el registro en Sheets ya lo hace el servicio)
      const efectosISO =
        resultado?.fechaEfectosISO ||
        resultado?.fechaFinCicloISO ||
        (typeof resultado?.current_period_end === 'number'
          ? new Date(resultado.current_period_end * 1000).toISOString()
          : undefined);

      try {
        // Obtener la fecha REAL de efectos (fin de ciclo) desde Stripe (opcional, solo para devolverla al cliente)
        let fechaEfectosISO = new Date().toISOString(); // fallback (por si fuese inmediata)
        const customers = await stripe.customers.list({ email, limit: 1 });
        if (customers.data.length) {
          const subs = await stripe.subscriptions.list({
            customer: customers.data[0].id,
            status: 'all',
            limit: 10
          });
          // Preferimos la que queda programada a fin de ciclo
          const s = subs.data.find(x => x.cancel_at_period_end) || subs.data.find(x => x.status === 'active');
          if (s?.current_period_end) {
            fechaEfectosISO = new Date(s.current_period_end * 1000).toISOString();
          }
        }


      } catch (e) {
        console.warn('⚠️ calcular fecha efectos (informativa):', e?.message || e);
      }

      // Señaliza si vino por HMAC y añade cabecera informativa
      res.setHeader('X-HMAC-Checked', via === 'hmac' ? '1' : '0');
      return res.json({ cancelada: true, efectos: efectosISO, via });
    }

    // ⚠️ Si no canceló pero no se marcó como error
    console.warn('⚠️ Cancelación no completada (sin error pero no marcada como cancelada)');
    return res.status(400).json({
      cancelada: false,
      mensaje: 'No se pudo completar la cancelación'
    });

  } catch (error) {
    console.error('❌ Error en desactivarMembresiaClub:', error.message);
    return res.status(500).json({
      cancelada: false,
      mensaje: 'Error interno del servidor.'
    });
  }
});

app.post('/eliminar-cuenta', requireJson, accountLimiter, async (req, res) => {
  const { email, password, token } = req.body;
  const tokenEsperado = 'eliminarCuenta@2025!';

  if (token !== tokenEsperado) {
    return res.status(403).json({ eliminada: false, mensaje: 'Token inválido' });
  }

  if (!email || !password) {
    return res.status(400).json({ eliminada: false, mensaje: 'Faltan datos obligatorios' });
  }

  try {
    const resultado = await eliminarUsuarioWordPress(email, password);
    if (!resultado.ok) {
      return res.status(401).json({ eliminada: false, mensaje: resultado.mensaje });
    }

    console.log(`🧨 Cuenta eliminada correctamente en WordPress para: ${email}`);
    return res.json({ eliminada: true });
  } catch (error) {
    console.error('❌ Error al procesar eliminación:', error.message);
    try {
      await alertAdmin({
        area: 'eliminar_cuenta_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}

    return res.status(500).json({ eliminada: false, mensaje: 'Error interno del servidor' });
  }
});

app.post('/crear-portal-cliente', requireJson, accountLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'No existe cliente Stripe para este email.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: 'https://www.laboroteca.es/mi-cuenta'
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creando portal cliente Stripe:', error.message);
    try {
      await alertAdmin({
        area: 'stripe_portal_cliente_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}

    return res.status(500).json({ error: 'No se pudo crear el portal de cliente Stripe' });
  }
});

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err?.message || String(err));
  try {
    alertAdmin({
      area: 'uncaughtException',
      email: '-',
      err,
      meta: { pid: process.pid, nodeEnv: process.env.NODE_ENV }
    }).catch(() => {});
  } catch (_) {}
});

process.on('unhandledRejection', (err) => {
  console.error('💥 unhandledRejection:', err?.message || String(err));
  try {
    alertAdmin({
      area: 'unhandledRejection',
      email: '-',
      err,
      meta: { pid: process.pid, nodeEnv: process.env.NODE_ENV }
    }).catch(() => {});
  } catch (_) {}
});


// ─────────────────────────────────────
// Ruta GET manual: /cron/bajas-club
// Railway Scheduler o curl → activa el plan B
// ─────────────────────────────────────
app.get('/cron/bajas-club', async (req, res) => {
  try {
    await cronBajasClub();
    return res.json({ ok: true, mensaje: 'Cron de bajasClub ejecutado' });
  } catch (e) {
    console.error('❌ Cron bajasClub error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Error interno' });
  }
});

// ─────────────────────────────────────
// Manejador de errores central (último)
// ─────────────────────────────────────
app.use((err, req, res, _next) => {
  const msg = err?.message || String(err);
  const rid = req.headers['x-request-id'] || '-';
  // Log sin datos sensibles; no volcamos headers ni body completos
  console.error('🔥 ERROR', JSON.stringify({
    path: req.path,
    method: req.method,
    rid,
    msg
  }));
  try {
    alertAdmin({
      area: 'express_error',
      email: '-',
      err,
      meta: { path: req.path, method: req.method, rid }
    }).catch(() => {});
  } catch (_) {}
  res.status(err.status || 500).json({ ok:false, error:'INTERNAL_ERROR' });
});

// 🚧 404 con traza (DEBE ir justo antes del listen)
app.use((req, res) => {
  console.warn('🟡 404', req.method, req.originalUrl);
  res.status(404).json({ ok:false, error:'NOT_FOUND' });
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
