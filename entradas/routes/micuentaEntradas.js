// entradas/routes/micuentaEntradas.js
router.get('/cuenta/entradas-lite', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });

    const snap = await firestore.collection('entradasCompradas')
      .where('emailComprador', '==', email)
      .get();

    if (snap.empty) return res.json({ ok: true, count: 0, items: [] });

    const ahora = dayjs().tz(TZ);
    const items = [];

    snap.forEach(doc => {
      const d = doc.data();
      const f = parseFechaMadrid(d.fechaActuacion || d.fechaEvento || '');
      if (f && f.isAfter(ahora)) {
        items.push({
          descripcionProducto: d.descripcionProducto,
          direccionEvento: d.direccionEvento || '',
          fecha: f.format('DD/MM/YYYY HH:mm'),
        });
      }
    });

    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error('❌ /cuenta/entradas-lite', e);
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});
