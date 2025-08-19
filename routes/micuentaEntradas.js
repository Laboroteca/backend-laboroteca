// routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const { Storage } = require('@google-cloud/storage');
const { enviarEmailConEntradas } = require('../entradas/services/enviarEmailConEntradas');

const storage = new Storage({
  credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
});
const bucket = storage.bucket('laboroteca-facturas');

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * GET /cuenta/entradas?email=...
 * Devuelve grupos FUTUROS por (descripcionProducto + direccionEvento + fechaEvento) con cantidad.
 */
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const ahora = Date.now();
    const snap = await firestore.collection('entradas')
      .where('email', '==', email)
      .get();

    const grupos = new Map();
    snap.forEach(doc => {
      const d = doc.data();
      // fechaEvento puede venir como string; no la parseamos, comparamos si existe timestamp opcional
      const fechaEvento = d.fechaEvento || '';
      // si guardaste fecha en otro formato, puedes filtrar en el front; aquí devolvemos todo y el shortcode lo muestra si la fecha no ha pasado
      const key = JSON.stringify({
        descripcionProducto: d.descripcionProducto || d.slugEvento || 'Evento',
        direccionEvento: d.direccionEvento || '',
        fechaEvento: fechaEvento
      });
      const item = grupos.get(key) || { descripcionProducto: '', direccionEvento: '', fechaEvento: '', cantidad: 0 };
      item.descripcionProducto = d.descripcionProducto || d.slugEvento || 'Evento';
      item.direccionEvento = d.direccionEvento || '';
      item.fechaEvento = fechaEvento;
      item.cantidad += 1;
      grupos.set(key, item);
    });

    // Opcional: podríamos filtrar por fecha futura si tu fechaEvento es ISO.
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
 * Reúne los PDFs del comprador para ese evento desde GCS y los reenvía por email.
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

    // Busca códigos del comprador para ese evento en Firestore
    const q = await firestore.collection('entradas')
      .where('email', '==', comprador)
      .where('descripcionProducto', '==', desc)
      .get();

    if (q.empty) {
      return res.status(404).json({ error: 'No se han encontrado entradas para ese evento' });
    }

    const carpeta = `entradas/${slugify(desc)}/`;
    const entradasBuffers = [];

    // Carga cada PDF desde GCS según su código
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
      nombre: comprador, // si quieres, puedes enriquecerlo con nombre real si lo guardas
      entradas: entradasBuffers,
      descripcionProducto: desc,
      importe: 0, // aquí no necesitamos el importe para reenvío
    });

    return res.json({ ok: true, reenviadas: entradasBuffers.length });
  } catch (e) {
    console.error('❌ POST /entradas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando entradas' });
  }
});

module.exports = router;
