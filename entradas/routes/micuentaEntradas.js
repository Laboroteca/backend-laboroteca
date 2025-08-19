// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

// ✅ este router acepta JSON y form-urlencoded (para el formulario de WP)
router.use(express.json({ limit: '1mb' }));
router.use(express.urlencoded({ extended: true, limit: '1mb' }));

const admin = require('../../firebase');
const firestore = admin.firestore();

const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

const dayjs = require('dayjs');
const customParse = require('dayjs/plugin/customParseFormat');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(customParse); dayjs.extend(utc); dayjs.extend(tz);

const TZ = 'Europe/Madrid';

// ───────── GCS
const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
  ),
});
const bucket = storage.bucket('laboroteca-facturas');

// ───────── Utils
function slugify(s = '') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
function parseFechaMadrid(s = '') {
  if (!s) return null;
  const d1 = dayjs.tz(s, 'DD/MM/YYYY - HH:mm', TZ, true);
  if (d1.isValid()) return d1;
  const d2 = dayjs(s);
  return d2.isValid() ? d2.tz(TZ) : null;
}

// Agrupa docs por (desc+dir+fecha) y devuelve SOLO futuros
async function cargarEventosFuturos(email) {
  const ahora = dayjs().tz(TZ);
  const grupos = new Map();

  function acumula(d) {
    const desc  = d.descripcionProducto || d.nombreEvento || d.slugEvento || 'Evento';
    const dir   = d.direccionEvento || '';
    const fecha = d.fechaActuacion || d.fechaEvento || '';
    const f = parseFechaMadrid(fecha);
    if (!f || f.isBefore(ahora)) return;

    const key = JSON.stringify({ desc, dir, fecha });
    const item = grupos.get(key) || {
      descripcionProducto: desc,
      direccionEvento: dir,
      fechaEvento: fecha,
      cantidad: 0
    };
    item.cantidad += 1;
    grupos.set(key, item);
  }

  // 1) entradasCompradas (emailComprador)
  const qA = await firestore.collection('entradasCompradas')
    .where('emailComprador', '==', email)
    .get();
  qA.forEach(doc => acumula(doc.data()));

  // 2) entradas (email)
  const qB = await firestore.collection('entradas')
    .where('email', '==', email)
    .get();
  qB.forEach(doc => acumula(doc.data()));

  // 3) entradas (emailComprador) por compatibilidad
  const qC = await firestore.collection('entradas')
    .where('emailComprador', '==', email)
    .get();
  qC.forEach(doc => acumula(doc.data()));

  return Array.from(grupos.values());
}

/**
 * GET /cuenta/entradas?email=...
 * Devuelve grupos (solo FUTUROS) por descripcion+direccion+fecha con cantidad
 */
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const items = await cargarEventosFuturos(email);
    return res.json({ ok: true, items });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

/**
 * GET /cuenta/entradas-lite?email=...
 * Resumen: total de entradas futuras y el primer evento (si existe)
 */
router.get('/cuenta/entradas-lite', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const items = await cargarEventosFuturos(email);
    const count = items.reduce((acc, it) => acc + (it.cantidad || 0), 0);

    // ordena por fecha asc si se puede parsear
    items.sort((a, b) => {
      const fa = parseFechaMadrid(a.fechaEvento); const fb = parseFechaMadrid(b.fechaEvento);
      if (!fa && !fb) return 0; if (!fa) return 1; if (!fb) return -1;
      return fa.valueOf() - fb.valueOf();
    });

    return res.json({
      ok: true,
      count,
      items,
      first: items[0] || null
    });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas-lite', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

/**
 * POST /entradas/reenviar
 * Body (form o JSON):
 *   { emailDestino, emailComprador, descripcionProducto }
 * Reúne PDFs desde GCS por descripcionProducto y email, y los reenvía por email.
 */
router.post('/entradas/reenviar', async (req, res) => {
  try {
    const {
      emailDestino = '',
      emailComprador = '',
      descripcionProducto = ''
    } = req.body || {};

    const to = String(emailDestino).trim().toLowerCase();
    const comprador = String(emailComprador).trim().toLowerCase();
    const desc = String(descripcionProducto).trim();

    if (!to || !comprador || !desc) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, emailComprador, descripcionProducto' });
    }

    // Busca códigos en ambas colecciones
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
    q1.forEach(d => d.data().codigo && codigos.add(d.data().codigo));
    q2.forEach(d => d.data().codigo && codigos.add(d.data().codigo));

    if (codigos.size === 0) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    const carpeta = `entradas/${slugify(desc)}/`;
    const entradasBuffers = [];

    // por seguridad, máximo 20 adjuntos
    const MAX_ADJUNTOS = 20;
    for (const codigo of Array.from(codigos).slice(0, MAX_ADJUNTOS)) {
      const file = bucket.file(`${carpeta}${codigo}.pdf`);
      const [exists] = await file.exists();
      if (!exists) continue;
      const [buf] = await file.download();
      entradasBuffers.push({ buffer: buf });
    }

    if (entradasBuffers.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado PDFs en GCS para ese evento' });
    }

    await enviarEmailConEntradas({
      email: to,
      nombre: comprador,
      entradas: entradasBuffers,
      descripcionProducto: desc,
      importe: 0
    });

    return res.json({ ok: true, reenviadas: entradasBuffers.length });
  } catch (e) {
    console.error('❌ POST /entradas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando entradas' });
  }
});

module.exports = router;
