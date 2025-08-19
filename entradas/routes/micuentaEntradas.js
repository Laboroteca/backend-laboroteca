// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

const admin = require('../../firebase');
const firestore = admin.firestore();

const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

// ───────────────────────── GCS
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

// agrupa por (desc+dir+fecha) y filtra futuros
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
// Body: { emailDestino, emailComprador, descripcionProducto }
router.post('/entradas/reenviar', async (req, res) => {
  try {
    const body = req.body || {};
    const to         = String(body.emailDestino || '').trim().toLowerCase();
    const comprador  = String(body.emailComprador || '').trim().toLowerCase();
    const desc       = String(body.descripcionProducto || '').trim();

    if (!to || !comprador || !desc) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, emailComprador, descripcionProducto' });
    }

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
    q1.forEach(d => { const x = d.data(); if (x && x.codigo) codigos.add(x.codigo); });
    q2.forEach(d => { const x = d.data(); if (x && x.codigo) codigos.add(x.codigo); });

    if (codigos.size === 0) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    const buffers = await obtenerBuffersPdfsPorCodigos(desc, Array.from(codigos));
    if (buffers.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado PDFs en GCS para ese evento' });
    }

    await enviarEmailConEntradas({
      email: to,
      nombre: comprador,
      entradas: buffers,
      descripcionProducto: desc,
      importe: 0
    });

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

module.exports = router;
