// entradas/routes/micuentaEntradas.js
const express = require('express');
const router = express.Router();

const admin = require('../../firebase');
const firestore = admin.firestore();

/**
 * GET /cuenta/entradas?email=...
 * Lee SOLO Firestore (entradasCompradas, y también entradas si existen)
 * y devuelve grupos por evento (nombre/descripcion/slug) con cantidad.
 * No depende de Sheets ni de GCS.
 */
router.get('/cuenta/entradas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    // 1) Consultas en ambas colecciones por compatibilidad
    const queries = [
      firestore.collection('entradasCompradas').where('emailComprador', '==', email).get(),
      firestore.collection('entradasCompradas').where('email', '==', email).get(),
      firestore.collection('entradas').where('email', '==', email).get(),
      firestore.collection('entradas').where('emailComprador', '==', email).get(),
    ];

    const snaps = await Promise.all(queries);

    // 2) Agrupar por "evento"
    const grupos = new Map();
    const acum = (snap) => snap.forEach(doc => {
      const d = doc.data() || {};
      const desc =
        d.descripcionProducto ||
        d.nombreEvento ||
        d.slugEvento ||
        'Evento';
      const dir   = d.direccionEvento || '';               // puede venir vacío en históricos
      const fecha = d.fechaEvento || d.fechaActuacion || ''; // puede venir vacío en históricos

      const key = JSON.stringify({ desc, dir, fecha });
      const item = grupos.get(key) || {
        descripcionProducto: desc,
        direccionEvento: dir,
        fechaEvento: fecha,
        cantidad: 0
      };
      item.cantidad += 1;
      grupos.set(key, item);
    });

    snaps.forEach(acum);

    return res.json({ ok: true, items: Array.from(grupos.values()) });
  } catch (e) {
    console.error('❌ GET /cuenta/entradas', e);
    return res.status(500).json({ error: 'Error listando entradas' });
  }
});

module.exports = router;
