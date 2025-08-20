// routes/micuentaFacturas.js
const express = require('express');
const router = express.Router();

const admin = require('../firebase');
const firestore = admin.firestore();

const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ========= Config seguridad (firma HMAC entre WP y backend)
const SHARED_SECRET = (process.env.ACCOUNT_API_SECRET || '').trim();
const HMAC_WINDOW_SECONDS = 5 * 60; // 5 min

// ========= Config FacturaCity (fallback PDF si no hay en GCS)
const FACTURACITY_API_KEY = (process.env.FACTURACITY_API_KEY || '').trim().replace(/"/g, '');
const FACTURACITY_API_URL = process.env.FACTURACITY_API_URL || '';
const AXIOS_TIMEOUT = 10000;

// ========= GCS
const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64 || '', 'base64').toString('utf8')
  ),
});
const bucket = storage.bucket('laboroteca-facturas');

// ========= Email (servicio propio que adjunta varios PDFs)
const { enviarEmailConFacturas } = require('../services/enviarEmailConFacturas');

// -------------------------------- Utils --------------------------------
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(s) {
  try { return JSON.parse(Buffer.from(String(s || ''), 'base64url').toString('utf8')); }
  catch { return null; }
}
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
function timingSafeEqualHex(aHex, bHex) {
  try {
    const a = Buffer.from(String(aHex || ''), 'hex');
    const b = Buffer.from(String(bHex || ''), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function signHmac(str) {
  if (!SHARED_SECRET) return '';
  return crypto.createHmac('sha256', SHARED_SECRET).update(str).digest('hex');
}
function signDocId(id, email) {
  if (!SHARED_SECRET) return '';
  return signHmac(`${email}|${id}`);
}

// -------- Middleware de autenticación con compatibilidad legada --------
function requireSignedUser(req, res, next) {
  // Si hay secreto → exige firma
  if (SHARED_SECRET) {
    const ts = String(req.headers['x-lab-ts'] || req.query.ts || '');
    const token = String(req.headers['x-lab-token'] || req.query.token || '');
    const emailFromReq = (
      req.query.email ||
      req.body.emailUsuario ||
      req.body.emailDestino ||
      ''
    ).toString().trim().toLowerCase();

    if (!emailFromReq || !ts || !token) {
      return res.status(401).json({ error: 'Falta autenticación' });
    }
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    const skew = Math.abs(Date.now() - tsNum * 1000);
    if (skew > HMAC_WINDOW_SECONDS * 1000) {
      return res.status(401).json({ error: 'Token expirado' });
    }
    const expected = signHmac(`${emailFromReq}|${ts}`);
    if (!timingSafeEqualHex(expected, token)) {
      return res.status(401).json({ error: 'Firma inválida' });
    }
    req.userEmail = emailFromReq;
    return next();
  }

  // Modo compat (sin secreto): NO SEGURO, pero no rompe mientras ajustas WP
  const legacyEmail = (
    req.query.email ||
    req.body.emailUsuario ||
    ''
  ).toString().trim().toLowerCase();
  if (!legacyEmail) {
    return res.status(401).json({ error: 'Email requerido' });
  }
  console.warn('⚠️ ACCOUNT_API_SECRET no configurado. Ruta en modo compat (menor seguridad).');
  req.userEmail = legacyEmail;
  return next();
}

// Descargar fichero si existe
async function downloadIfExists(path) {
  const f = bucket.file(path);
  const [exists] = await f.exists();
  if (!exists) return null;
  const [buf] = await f.download();
  return buf;
}

// Selección “mejor coincidencia” dentro de una carpeta de email
async function findBestPdfInFolder({ email, invoiceId, numeroFactura, idfactura, descripcionProducto, fechaISO }) {
  const prefix = `facturas/${email}/`;
  const [files] = await bucket.getFiles({ prefix });

  if (!files || files.length === 0) return null;

  const slug = slugify(descripcionProducto || '');
  const targetTs = fechaISO ? new Date(fechaISO).getTime() : 0;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const f of files) {
    const full = f.name || '';
    const name = full.split('/').pop() || '';
    const low  = name.toLowerCase();

    const hasInvoice = invoiceId && low.includes(String(invoiceId).toLowerCase());
    const hasNumero  = numeroFactura && low.includes(String(numeroFactura).toLowerCase());
    const hasSlug    = slug && low.includes(`-${slug}.pdf`);

    if (!(hasInvoice || hasNumero || hasSlug)) continue;

    let score = 0;
    const lead = low.split('-')[0];
    const ts = /^\d{12,}$/.test(lead) ? parseInt(lead, 10) : NaN;
    if (Number.isFinite(ts) && targetTs) score = Math.abs(ts - targetTs);

    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }

  if (!best) return null;
  const [buf] = await best.download();
  return { buffer: buf, filename: best.name.split('/').pop() };
}

// Exportar desde FacturaCity si tenemos idfactura
async function exportFromFacturaCity(idfactura, numeroFactura) {
  if (!idfactura || !FACTURACITY_API_KEY || !FACTURACITY_API_URL) return null;
  const url = `${FACTURACITY_API_URL}/exportarFacturaCliente/${idfactura}?lang=es_ES`;
  const resp = await axios.get(url, {
    headers: { Token: FACTURACITY_API_KEY },
    responseType: 'arraybuffer',
    timeout: AXIOS_TIMEOUT
  });
  return { buffer: resp.data, filename: `factura-${numeroFactura || idfactura}.pdf` };
}

// Obtiene el PDF de una factura (GCS con varios patrones → fallback FacturaCity)
async function obtenerPdfFactura({ email, storagePath, invoiceId, numeroFactura, idfactura, descripcionProducto, fechaISO, docId }) {
  if (storagePath) {
    const buf = await downloadIfExists(storagePath);
    if (buf) {
      const filename = storagePath.split('/').pop() || `factura-${numeroFactura || idfactura || docId}.pdf`;
      return { buffer: buf, filename };
    }
  }

  const prefix = `facturas/${email}/`;
  const directCandidates = [
    invoiceId && `${prefix}${invoiceId}.pdf`,
    numeroFactura && `${prefix}${numeroFactura}.pdf`,
    idfactura && `${prefix}${idfactura}.pdf`,
    docId && `${prefix}${docId}.pdf`,
  ].filter(Boolean);

  for (const c of directCandidates) {
    const buf = await downloadIfExists(c);
    if (buf) return { buffer: buf, filename: c.split('/').pop() };
  }

  const best = await findBestPdfInFolder({ email, invoiceId, numeroFactura, idfactura, descripcionProducto, fechaISO });
  if (best) return best;

  const fromFc = await exportFromFacturaCity(idfactura, numeroFactura);
  if (fromFc) return fromFc;

  return null;
}

// ========= Rate limit básico para estas rutas
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });

// =================== LISTADO ===================
// GET /cuenta/facturas?email=...&pageSize=15&cursor=...
router.get('/cuenta/facturas', limiter, requireSignedUser, async (req, res) => {
  try {
    const email = String(req.userEmail || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '15'), 10) || 15, 1), 50);
    const cursorRaw = req.query.cursor ? decodeCursor(req.query.cursor) : null;

    // where + orderBy compuesto → requiere índice: (email ==), fechaISO desc, __name__ desc
    let q = firestore
      .collection('facturas')
      .where('email', '==', email)
      .orderBy('fechaISO', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
      .limit(pageSize + 1); // pedimos 1 extra para saber si hay más

    if (cursorRaw && cursorRaw.fechaISO && cursorRaw.docId) {
      q = q.startAfter(cursorRaw.fechaISO, cursorRaw.docId);
    }

    const snap = await q.get();

    const items = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      items.push({
        docId: doc.id,
        sig: signDocId(doc.id, email), // firma por elemento (si hay secreto)
        fechaISO: d.fechaISO || null,
        fecha: d.fechaTexto || (d.fechaISO ? new Date(d.fechaISO).toLocaleDateString('es-ES') : ''),
        numeroFactura: d.numeroFactura || d.idfactura || d.invoiceId || '',
        descripcionProducto: d.descripcionProducto || d.nombreProducto || '',
        importeConIVA: (typeof d.importeTotalIVA === 'number') ? d.importeTotalIVA : null,
        idfactura: d.idfactura || null,
        invoiceId: d.invoiceId || null,
        storagePath: d.storagePath || d.nombreArchivo || null
      });
    });

    let hasMore = false;
    let nextCursor = null;
    if (items.length > pageSize) {
      const last = items[pageSize - 1];
      hasMore = true;
      nextCursor = encodeCursor({ fechaISO: last.fechaISO || '', docId: last.docId });
      items.length = pageSize;
    }

    return res.json({ ok: true, items, hasMore, cursor: nextCursor });
  } catch (e) {
    console.error('❌ GET /cuenta/facturas', e);
    return res.status(500).json({ error: 'Error listando facturas' });
  }
});

// =================== REENVÍO ===================
// POST /facturas/reenviar
// Body:
//   { emailDestino: "...", ids: [ "<docId>" | {id:"...", sig:"..."} , ... ] }
router.post('/facturas/reenviar', limiter, requireSignedUser, async (req, res) => {
  try {
    const body = req.body || {};
    const to = String(body.emailDestino || '').trim().toLowerCase();
    const owner = String(req.userEmail || '').trim().toLowerCase();

    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const pairs = rawIds.map(v => {
      if (v && typeof v === 'object' && v.id) return { id: String(v.id), sig: String(v.sig || '') };
      return { id: String(v || ''), sig: '' };
    }).filter(p => p.id);

    if (!to || !owner || pairs.length === 0) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, ids[]' });
    }

    // Si hay secreto → exigir firma por elemento
    let verifiedIds = [];
    if (SHARED_SECRET) {
      verifiedIds = pairs
        .filter(p => p.sig && timingSafeEqualHex(signDocId(p.id, owner), p.sig))
        .map(p => p.id);
      if (verifiedIds.length === 0) {
        return res.status(400).json({ error: 'Selección inválida' });
      }
    } else {
      console.warn('⚠️ ACCOUNT_API_SECRET no configurado. Reenvío sin verificación de firma de items.');
      verifiedIds = pairs.map(p => p.id);
    }

    // Seguridad: todas las facturas deben pertenecer al owner
    const reads = await Promise.all(verifiedIds.map(id => firestore.collection('facturas').doc(id).get()));
    const validDocs = reads
      .filter(s => s.exists)
      .map(s => ({ id: s.id, ...(s.data() || {}) }))
      .filter(d => (d.email || '').toLowerCase().trim() === owner);

    if (validDocs.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado facturas del usuario' });
    }

    // Obtener PDFs (GCS → fallback FC)
    const adjuntos = [];
    for (const d of validDocs) {
      const pdf = await obtenerPdfFactura({
        email: owner,
        storagePath: d.storagePath || d.nombreArchivo || null,
        invoiceId: d.invoiceId || null,
        numeroFactura: d.numeroFactura || null,
        idfactura: d.idfactura || null,
        descripcionProducto: d.descripcionProducto || d.nombreProducto || '',
        fechaISO: d.fechaISO || null,
        docId: d.id
      });
      if (pdf && pdf.buffer?.length) adjuntos.push(pdf);
    }

    if (adjuntos.length === 0) {
      return res.status(404).json({ error: 'No se pudieron localizar PDFs de las facturas seleccionadas' });
    }

    await enviarEmailConFacturas({
      email: to,
      nombre: owner,
      facturas: adjuntos, // [{ buffer, filename }]
      count: adjuntos.length
    });

    return res.json({ ok: true, reenviadas: adjuntos.length });
  } catch (e) {
    console.error('❌ POST /facturas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando facturas' });
  }
});

// GET defensivo para no navegar por error
router.get('/facturas/reenviar', (_req, res) => {
  res.status(405).json({ error: 'Usa método POST con JSON' });
});

module.exports = router;
