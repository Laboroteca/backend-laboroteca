const express = require('express');
const router = express.Router();
const admin = require('../../firebase');
const firestore = admin.firestore();

/**
 * GET /cuenta/entradas-lite
 * Devuelve listado simplificado de entradas para un email
 */
router.get('/cuenta/entradas-lite', async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Falta email' });
    }

    const ref = firestore.collection('entradasCompradas').doc(email);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.json({ ok: true, count: 0, items: [] });
    }

    const data = snap.data();
    const items = data?.items || [];

    res.json({
      ok: true,
      count: items.length,
      items
    });
  } catch (err) {
    console.error('❌ Error en /cuenta/entradas-lite:', err);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = router;
