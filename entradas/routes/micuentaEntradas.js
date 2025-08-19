// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

const admin = require('../../firebase');                 // <-- ruta correcta
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
  credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
});
const bucket = storage.bucket('laboroteca-facturas');

function slugify(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function parseFechaMadrid(s='') {
  if (!s) return null;
  const d1 = dayjs.tz(s, 'DD/MM/YYYY - HH:mm', TZ, true);
  if (d1.isValid()) return d1;
  const d2 = dayjs(s);
  return d2.isValid() ? d2.tz(TZ) : null;
}

/**
 * GET /cuenta/entradas?email=...
 * Devuelve grupos (solo FUTUROS) por descripcion+direccion+fecha con cantidad
 */
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const [qA, qB, qC] = await Promise.all([
      // 1) entradasCompradas por emailComprador
      firestore.collection('entradasCompradas')
        .where('emailComprador', '==', email).get(),
      // 2) entradas por email
      firestore.collection('entradas')
        .where('email', '==', email).get(),
      // 3) entradas por emailComprador (por si acaso)
      firestore.collection('entradas')
        .where('emailComprador', '==', email).get(),
    ]);

    const ahora = dayjs().tz(TZ);
    const grupos = new Map();

    function acumula(d) {
      const desc = d.descripcionProducto || d.nombreEvento || d.slugEvento || 'Evento';
      const dir  = d.direccionEvento || '';
      const fecha = d.fechaActuacion || d.fechaEvento || '';
      const f = parseFechaMadrid(fecha);
      if (!f || f.isBefore(ahora)) return; // solo futuros

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

    // entradasCompradas
    qA.forEach(doc => acumula(doc.data()));
    // entradas (dos consultas)
    qB.forEach(doc => acumula(doc.data()));
    qC.forEach(doc => acumula(doc.data()));

    const items = Array.from(grupos.values());
    return res.json({ ok: true, items });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

/**
 * POST /entradas/reenviar
 * Body: { emailDestino, emailComprador, descripcionProducto, direccionEvento, fechaActuacion }
 * Reúne PDFs desde GCS por descripcionProducto y email, y los reenvía por email.
 */
router.post('/entradas/reenviar', async (req, res) => {
  try {
    const {
      emailDestino = '',
      emailComprador = '',
      descripcionProducto = '',
      direccionEvento = '',
      fechaActuacion = ''
    } = req.body || {};

    const to = String(emailDestino).trim().toLowerCase();
    const comprador = String(emailComprador).trim().toLowerCase();
    const desc = String(descripcionProducto).trim();
    if (!to || !comprador || !desc) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, emailComprador, descripcionProducto' });
    }

    // Buscar códigos del comprador para ese evento (miramos ambas colecciones)
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

    for (const codigo of codigos) {
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
