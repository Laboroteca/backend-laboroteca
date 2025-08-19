// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../entradas/services/enviarEmailConEntradas');

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

// ───────── GET /cuenta/entradas ─────────
// Devuelve grupos FUTUROS por (descripcionProducto + direccionEvento + fechaEvento) con cantidad.
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const ahora = dayjs().tz('Europe/Madrid');

    // Buscar tanto por email como por emailComprador
    const [q1, q2] = await Promise.all([
      firestore.collection('entradas').where('email', '==', email).get(),
      firestore.collection('entradas').where('emailComprador', '==', email).get()
    ]);

    const grupos = new Map();

    const acumular = snap => snap.forEach(doc => {
      const d = doc.data();

      const desc = d.descripcionProducto || d.nombreEvento || d.slugEvento || 'Evento';
      const dir = d.direccionEvento || '';
      const fechaStr = d.fechaEvento || '';

      let futura = true;
      if (fechaStr) {
        const f = dayjs.tz(fechaStr, 'DD/MM/YYYY - HH:mm', 'Europe/Madrid', true);
        futura = f.isValid() ? f.isSame(ahora) || f.isAfter(ahora) : true;
      }

      if (!futura) return; // ❌ ocultar eventos pasados

      const key = JSON.stringify({ desc, dir, fechaStr });
      const item = grupos.get(key) || { descripcionProducto: desc, direccionEvento: dir, fechaEvento: fechaStr, cantidad: 0 };
      item.cantidad += 1;
      grupos.set(key, item);
    });

    acumular(q1);
    acumular(q2);

    return res.json({ ok: true, items: Array.from(grupos.values()) });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

// ───────── POST /entradas/reenviar ─────────
// Body: { emailDestino, emailComprador, descripcionProducto, direccionEvento, fechaActuacion }
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

    // Buscar entradas del comprador para ese evento
    const q = await firestore.collection('entradas')
      .where('emailComprador', '==', comprador)
      .where('descripcionProducto', '==', desc)
      .get();

    if (q.empty) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    const carpeta = `entradas/${slugify(desc)}/`;
    const entradasBuffers = [];

    for (const doc of q.docs) {
      const { codigo } = doc.data();
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
      importe: 0,
    });

    return res.json({ ok: true, reenviadas: entradasBuffers.length });
  } catch (e) {
    console.error('❌ POST /entradas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando entradas' });
  }
});

module.exports = router;
