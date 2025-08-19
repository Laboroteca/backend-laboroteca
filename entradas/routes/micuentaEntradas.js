// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

// IMPORTS ajustados a esta ruta
const admin = require('../../firebase');
const firestore = admin.firestore();
const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

// ───────── Google Cloud Storage ─────────
const storage = new Storage({
  credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
});
const bucket = storage.bucket('laboroteca-facturas');

// ───────── Utilidades ─────────
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const dayjs = require('dayjs');
const customParse = require('dayjs/plugin/customParseFormat');
const tz = require('dayjs/plugin/timezone');
const utc = require('dayjs/plugin/utc');
dayjs.extend(customParse); dayjs.extend(utc); dayjs.extend(tz);

/**
 * Normaliza un documento de Firestore de entradas a un modelo común
 */
function normalizeDoc(d) {
  return {
    email: (d.email || d.emailComprador || '').toLowerCase().trim(),
    codigo: d.codigo || '',

    // Etiquetas de evento
    descripcionProducto: d.descripcionProducto || d.nombreEvento || d.slugEvento || 'Evento',
    nombreEvento: d.nombreEvento || '',
    slugEvento: d.slugEvento || '',

    // Localización/fecha si existiera
    direccionEvento: d.direccionEvento || '',
    fechaEvento: d.fechaEvento || d.fechaActuacion || '' // "DD/MM/YYYY - HH:mm" si existe
  };
}

/**
 * Lee entradas de ambas colecciones (entradas y entradasCompradas) para un email
 */
async function fetchUserEntries(emailLower) {
  const queries = [
    firestore.collection('entradas').where('email', '==', emailLower).get(),
    firestore.collection('entradas').where('emailComprador', '==', emailLower).get(),
    firestore.collection('entradasCompradas').where('email', '==', emailLower).get(),
    firestore.collection('entradasCompradas').where('emailComprador', '==', emailLower).get(),
  ];
  const snaps = await Promise.all(queries);
  const rows = [];
  for (const snap of snaps) {
    snap.forEach(doc => rows.push(normalizeDoc(doc.data())));
  }
  return rows;
}

// ───────── GET /cuenta/entradas ─────────
// Agrupa por (descripcionProducto + direccionEvento + fechaEvento), mostrando SOLO futuros
// cuando hay fecha; si no hay fecha, no filtra (se muestra).
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const ahora = dayjs().tz('Europe/Madrid');
    const rows = await fetchUserEntries(email);

    const grupos = new Map();
    for (const r of rows) {
      // ¿La fecha es futura? (si no hay fecha, lo mostramos igualmente)
      let futura = true;
      if (r.fechaEvento) {
        const f = dayjs.tz(r.fechaEvento, 'DD/MM/YYYY - HH:mm', 'Europe/Madrid', true);
        futura = f.isValid() ? f.isSame(ahora) || f.isAfter(ahora) : true;
      }
      if (!futura) continue;

      const desc = r.descripcionProducto || 'Evento';
      const dir  = r.direccionEvento || '';
      const fec  = r.fechaEvento || '';

      const key = JSON.stringify({ desc, dir, fec });
      const item = grupos.get(key) || {
        descripcionProducto: desc,
        direccionEvento: dir,
        fechaEvento: fec,
        cantidad: 0
      };
      item.cantidad += 1;
      grupos.set(key, item);
    }

    return res.json({ ok: true, items: Array.from(grupos.values()) });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

/**
 * Busca un PDF {codigo}.pdf dentro de varios prefijos. Si no aparece, busca en TODO /entradas/.
 */
async function findPdfForCode(codigo, posiblesCarpetas) {
  // 1) Probar prefijos concretos primero (rápido)
  for (const carpeta of posiblesCarpetas) {
    const f = bucket.file(`entradas/${carpeta}/${codigo}.pdf`);
    const [exists] = await f.exists();
    if (exists) {
      const [buf] = await f.download();
      return buf;
    }
  }
  // 2) Búsqueda de rescate por todo el árbol (lenta, pero segura para históricos)
  const [files] = await bucket.getFiles({ prefix: 'entradas/' });
  for (const file of files) {
    if (file.name.endsWith(`/${codigo}.pdf`)) {
      const [buf] = await file.download();
      return buf;
    }
  }
  return null;
}

// ───────── POST /entradas/reenviar ─────────
// Body: { emailDestino, emailComprador, descripcionProducto }
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

    // Traer todas las entradas del usuario
    const rows = await fetchUserEntries(comprador);

    // Filtrar por el evento solicitado (coincide por nombre/desc)
    const delEvento = rows.filter(r =>
      (r.descripcionProducto && r.descripcionProducto === desc) ||
      (r.nombreEvento && r.nombreEvento === desc)
    );

    if (delEvento.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    // Intentar localizar PDFs con varios prefijos: slugify(desc) + slugEvento si existe
    const posiblesCarpetas = new Set();
    posiblesCarpetas.add(slugify(desc));
    for (const r of delEvento) {
      if (r.slugEvento) posiblesCarpetas.add(slugify(r.slugEvento));
    }

    const buffers = [];
    for (const r of delEvento) {
      if (!r.codigo) continue;
      const buf = await findPdfForCode(r.codigo, Array.from(posiblesCarpetas));
      if (buf) buffers.push({ buffer: buf });
    }

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

    return res.json({ ok: true, reenviadas: buffers.length });
  } catch (e) {
    console.error('❌ POST /entradas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando entradas' });
  }
});

module.exports = router;
