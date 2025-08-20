// 📂 /entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

const admin = require('../../firebase');
const firestore = admin.firestore();

const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');
const crypto = require('crypto');

// ───────────────────────── Config seguridad (rate limit + firma)
const RESEND_LIMIT_COUNT = Number(process.env.RESEND_LIMIT_COUNT || 3);      // máx. reenvíos por ventana
const RESEND_LIMIT_WINDOW_MS = Number(process.env.RESEND_LIMIT_WINDOW_MS || (60 * 60 * 1000)); // 1h
const HMAC_SHARED_SECRET =
  process.env.LB_SHARED_SECRET ||
  process.env.VALIDADOR_ENTRADAS_TOKEN || '';
  
// Bucket GCS
const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64 || '', 'base64').toString('utf8')
  ),
});
const bucket = storage.bucket('laboroteca-facturas');

// ───────────────────────── Utils
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

// "30/10/2025 - 17:00" -> Date
function parseFechaDMY(fecha) {
  if (!fecha) return null;
  const m = String(fecha).match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})$/);
  if (m) {
    const [_, dd, mm, yyyy, HH, MM] = m;
    // Interpretamos como hora local del servidor
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), 0);
    return isNaN(d.getTime()) ? null : d;
  }
  // fallback genérico
  const d = new Date(fecha);
  return isNaN(d.getTime()) ? null : d;
}

// agrupa por (desc+dir+fecha), SOLO futuros, y deduplica por código
async function cargarEventosFuturos(email) {
  const ahora = new Date();
  const grupos = new Map(); // key -> { descripcionProducto, direccionEvento, fechaEvento, codigos:Set }

  function acumula(id, d) {
    d = d || {};
    const desc  = d.descripcionProducto || d.nombreEvento || d.slugEvento || 'Evento';
    const dir   = d.direccionEvento || '';
    const fecha = d.fechaActuacion || d.fechaEvento || '';
    const f = parseFechaDMY(fecha);
    if (!f || f < ahora) return;

    // código único de la entrada (preferimos campo de datos; si no, doc.id)
    const codigo = (d.codigo || d.codigoEntrada || '').toString().trim() || String(id || '').trim();
    if (!codigo) return;

    const key = JSON.stringify({ desc, dir, fecha });
    let item = grupos.get(key);
    if (!item) {
      item = {
        descripcionProducto: desc,
        direccionEvento: dir,
        fechaEvento: fecha,
        codigos: new Set()
      };
      grupos.set(key, item);
    }
    // deduplicación: si ya está el código, no suma
    item.codigos.add(codigo);
  }

  // 1) entradasCompradas
  const qA = await firestore.collection('entradasCompradas')
    .where('emailComprador', '==', email)
    .get();
  qA.forEach(doc => acumula(doc.id, doc.data()));

  // 2) entradas (email)
  const qB = await firestore.collection('entradas')
    .where('email', '==', email)
    .get();
  qB.forEach(doc => acumula(doc.id, doc.data()));

  // 3) entradas (emailComprador)
  const qC = await firestore.collection('entradas')
    .where('emailComprador', '==', email)
    .get();
  qC.forEach(doc => acumula(doc.id, doc.data()));

  // Convertimos a array con cantidad = nº de códigos únicos por grupo
  const items = [];
  for (const item of grupos.values()) {
    items.push({
      descripcionProducto: item.descripcionProducto,
      direccionEvento: item.direccionEvento,
      fechaEvento: item.fechaEvento,
      cantidad: item.codigos.size
    });
  }
  return items;
}

// ───────────────────────── Rate limit en memoria (usar Redis en multi instancia)
const resendBuckets = new Map(); // key -> { count, resetAt }

/**
 * Controla cuota de reenvíos por clave.
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @returns {{ok:boolean, remaining?:number, retryAt?:number}}
 */
function checkResendQuota(key, limit = RESEND_LIMIT_COUNT, windowMs = RESEND_LIMIT_WINDOW_MS) {
  const now = Date.now();
  const item = resendBuckets.get(key);
  if (!item || now >= item.resetAt) {
    resendBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (item.count >= limit) {
    return { ok: false, retryAt: item.resetAt };
  }
  item.count++;
  return { ok: true, remaining: limit - item.count };
}

// ───────────────────────── Rutas lectura

// GET /cuenta/entradas?email=...
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const items = await cargarEventosFuturos(email);
    res.json({ ok: true, items });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    res.status(500).json({ error: 'Error listando entradas' });
  }
});

// GET /cuenta/entradas-lite?email=...
router.get('/cuenta/entradas-lite', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const items = await cargarEventosFuturos(email);
    const count = items.reduce((acc, it) => acc + (Number(it.cantidad) || 0), 0);

    // ordenar por fecha asc
    items.sort((a, b) => {
      const fa = parseFechaDMY(a.fechaEvento);
      const fb = parseFechaDMY(b.fechaEvento);
      if (!fa && !fb) return 0;
      if (!fa) return 1;
      if (!fb) return -1;
      return fa.getTime() - fb.getTime();
    });

    res.json({ ok: true, count, items, first: items[0] || null });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas-lite', e);
    res.status(500).json({ error: 'Error listando entradas' });
  }
});

// ───────────────────────── Reenvío por email

async function obtenerBuffersPdfsPorCodigos(descripcion, codigos) {
  const entradasBuffers = [];
  const unique = Array.from(new Set(codigos)).filter(Boolean);

  // 1) carpeta por descripción
  const carpeta = `entradas/${slugify(descripcion)}/`;
  for (const codigo of unique) {
    const file = bucket.file(`${carpeta}${codigo}.pdf`);
    const [exists] = await file.exists();
    if (exists) {
      const [buf] = await file.download();
      entradasBuffers.push({ buffer: buf });
    }
  }
  if (entradasBuffers.length > 0) return entradasBuffers;

  // 2) fallback: buscar {codigo}.pdf en cualquier subcarpeta de /entradas
  const [allFiles] = await bucket.getFiles({ prefix: 'entradas/' });
  const need = new Set(unique.map(c => `${c}.pdf`));

  for (const f of allFiles) {
    const name = f.name || '';
    const last = name.split('/').pop();
    if (last && need.has(last)) {
      const [buf] = await bucket.file(name).download();
      entradasBuffers.push({ buffer: buf });
      need.delete(last);
      if (need.size === 0) break;
    }
  }
  return entradasBuffers;
}

// POST /entradas/reenviar
// Body: { emailDestino, emailComprador, descripcionProducto, ts, sig }
router.post('/entradas/reenviar', async (req, res) => {
  try {
    const body = req.body || {};
    const to         = String(body.emailDestino || '').trim().toLowerCase();
    const comprador  = String(body.emailComprador || '').trim().toLowerCase();
    const desc       = String(body.descripcionProducto || '').trim();

    // ── Validaciones mínimas de payload
    if (!to || !comprador || !desc) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, emailComprador, descripcionProducto' });
    }

    // ── Verificación HMAC (prueba de propiedad desde WP)
    if (!HMAC_SHARED_SECRET) {
      console.warn('⚠️ LB_SHARED_SECRET no configurado; bloqueando por seguridad.');
      return res.status(401).json({ error: 'Firma requerida' });
    }
    const ts  = Number(body.ts || 0);
    const sig = String(body.sig || '');

    if (!ts || !sig) {
      return res.status(401).json({ error: 'Firma requerida' });
    }
    // Ventana de 5 minutos
    const MAX_SKEW = 300;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > MAX_SKEW) {
      return res.status(401).json({ error: 'Firma expirada' });
    }
    const base = `${comprador}|${desc}|${ts}`;
    const expected = crypto.createHmac('sha256', HMAC_SHARED_SECRET).update(base).digest('hex');
    // Comparación constante
    const okSig = (() => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      } catch { return false; }
    })();
    if (!okSig) {
      return res.status(401).json({ error: 'Firma inválida' });
    }

    // ── Rate limit (anti-spam) por (emailComprador, descripcion)
    const quotaKey = `${comprador}::${desc}`;
    const q = checkResendQuota(quotaKey);
    if (!q.ok) {
      const secs = Math.ceil((q.retryAt - Date.now()) / 1000);
      return res.status(429).json({ error: `Límite de reenvíos alcanzado. Inténtalo en ${secs}s.` });
    }

    // ── Buscar entradas del comprador para ese evento
    const [q1, q2] = await Promise.all([
      firestore.collection('entradasCompradas')
        .where('emailComprador', '==', comprador)
        .where('descripcionProducto', '==', desc)
        .get(),
      firestore.collection('entradas')
        .where('emailComprador', '==', comprador)
        .where('descripcionProducto', '==', desc)
        .get()
    ]);

    const codigos = new Set();
    let fecha = null;
    let direccion = null;
    let nombreComprador = null;

    const pickMeta = (x) => {
      if (!x) return;
      if (!fecha)     fecha     = x.fechaActuacion || x.fechaEvento || null;
      if (!direccion) direccion = x.direccionEvento || x.lugar || null;
      if (!nombreComprador) nombreComprador = x.nombreComprador || x.nombre || null;
    };

    q1.forEach(d => { const x = d.data(); if (x?.codigo) codigos.add(x.codigo); pickMeta(x); });
    q2.forEach(d => { const x = d.data(); if (x?.codigo) codigos.add(x.codigo); pickMeta(x); });

    if (codigos.size === 0) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    // ── Descargar PDFs de GCS
    const buffers = await obtenerBuffersPdfsPorCodigos(desc, Array.from(codigos));
    if (buffers.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado PDFs en GCS para ese evento' });
    }

    // Nombre visible: nombre de Firestore si existe; si no, parte local del email
    const nombreMostrar = (nombreComprador && String(nombreComprador).trim())
      ? String(nombreComprador).trim()
      : (comprador.split('@')[0] || '');

    // ── Enviar email con plantilla de reenvío
    await enviarEmailConEntradas({
      email: to,
      nombre: nombreMostrar,
      entradas: buffers,
      descripcionProducto: desc,
      importe: 0,      // opcional en reenvío (se mostraría como importe original si quisieras)
      modo: 'reenvio',
      fecha,
      direccion
      // subject/html opcionales
    });

    // ── Auditoría
    try {
      await firestore.collection('entradasReenvios').add({
        emailComprador: comprador,
        emailDestino: to,
        descripcionProducto: desc,
        cantidadAdjuntos: buffers.length,
        fechaActuacion: fecha || null,
        direccionEvento: direccion || null,
        at: new Date().toISOString(),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
      });
    } catch (logErr) {
      console.warn('⚠️ No se pudo registrar auditoría de reenvío:', logErr?.message || logErr);
    }

    res.json({ ok: true, reenviadas: buffers.length });
  } catch (e) {
    console.error('❌ POST /entradas/reenviar', e);
    res.status(500).json({ error: 'Error reenviando entradas' });
  }
});

// GET defensivo (no navegar al backend por error)
router.get('/entradas/reenviar', (_req, res) => {
  res.status(405).json({ error: 'Usa método POST con JSON' });
});

// ========== DISPONIBILIDAD ==========
// GET /entradas/disponibilidad?descripcion=...&formId=39&maximo=120 (maximo opcional)
// Cuenta códigos únicos y consulta config del evento en "events/<slug>"
router.get('/entradas/disponibilidad', async (req, res) => {
  try {
    const descRaw = String(req.query.descripcion || '').trim();
    const formId  = String(req.query.formId || '39').trim();
    const maxFromQuery = req.query.maximo ? parseInt(String(req.query.maximo), 10) : null;

    if (!descRaw) {
      return res.status(400).json({ error: 'Falta descripcion' });
    }
    const desc = descRaw;
    const slug = slugify(desc);

    // 1) Config del evento (si existe)
    let maximoEntradas = null;
    let fechaActuacion = null;

    const evDoc = await firestore.collection('events').doc(slug).get();
    if (evDoc.exists) {
      const ev = evDoc.data() || {};
      if (typeof ev.maximoEntradas === 'number') maximoEntradas = ev.maximoEntradas;
      if (ev.fechaActuacion) fechaActuacion = ev.fechaActuacion;
    }
    // Permite override por query mientras pueblas "events"
    if (maxFromQuery && Number.isFinite(maxFromQuery)) {
      maximoEntradas = maxFromQuery;
    }

    // 2) Reunir códigos únicos de ambas colecciones por descripcionProducto
    const [qA, qB] = await Promise.all([
      firestore.collection('entradas')
        .where('descripcionProducto', '==', desc)
        .get(),
      firestore.collection('entradasCompradas')
        .where('descripcionProducto', '==', desc)
        .get()
    ]);
    const codigos = new Set();
    qA.forEach(d => { const x = d.data(); if (x && x.codigo) codigos.add(x.codigo); });
    qB.forEach(d => { const x = d.data(); if (x && x.codigo) codigos.add(x.codigo); });

    const vendidos = codigos.size;

    // 3) Cerrado por fecha
    // Si no vino de events, intenta deducir del primer doc
    function parseFechaDMY(fecha) {
      if (!fecha) return null;
      const m = String(fecha).match(/^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})$/);
      if (m) {
        const [_, dd, mm, yyyy, HH, MM] = m;
        const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), 0);
        return isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(fecha);
      return isNaN(d.getTime()) ? null : d;
    }

    if (!fechaActuacion) {
      const anyDoc = qA.docs[0] || qB.docs[0];
      if (anyDoc && anyDoc.exists) {
        const x = anyDoc.data() || {};
        fechaActuacion = x.fechaActuacion || x.fechaEvento || null;
      }
    }
    let cerrado = false;
    if (fechaActuacion) {
      const d = parseFechaDMY(fechaActuacion);
      if (d && d.getTime() < Date.now()) cerrado = true;
    }

    // 4) Agotado si tenemos maximoEntradas y vendidos >= maximo
    const agotado = Number.isFinite(maximoEntradas) ? (vendidos >= maximoEntradas) : false;

    return res.json({
      ok: true,
      formId,
      descripcionProducto: desc,
      fechaActuacion: fechaActuacion || null,
      vendidos,
      maximo: Number.isFinite(maximoEntradas) ? maximoEntradas : null,
      agotado,
      cerrado
    });
  } catch (e) {
    console.error('❌ GET /entradas/disponibilidad', e);
    return res.status(500).json({ error: 'Error calculando disponibilidad' });
  }
});

module.exports = router;
