// /entradas/routes/estadoEvento.js
const express = require('express');
const router = express.Router();
const { Storage } = require('@google-cloud/storage');
const dayjs = require('dayjs');
const customParse = require('dayjs/plugin/customParseFormat');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(customParse);
dayjs.extend(utc);
dayjs.extend(tz);

const TZ = 'Europe/Madrid';

const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
  ),
});
const bucket = storage.bucket('laboroteca-facturas');

// Igual que el usado para nombrar carpetas en GCS (descripcionProducto normalizada)
function normalizar(texto = '') {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

async function contarPdfs(prefix) {
  let n = 0;
  await new Promise((resolve, reject) => {
    bucket.getFilesStream({ prefix })
      .on('data', (file) => {
        // cuenta SOLO PDFs reales (evita “directorios” y otros objetos)
        if (file?.name && file.name.endsWith('.pdf')) n++;
      })
      .on('error', reject)
      .on('end', resolve);
  });
  return n;
}

router.get('/estado', async (req, res) => {
  try {
    // Acepta ambos nombres de parámetros (compat con shortcode y Fluent Forms)
    const desc = String(req.query.desc || req.query.descripcionProducto || '').trim();
    const fechaStr = String(req.query.fecha || req.query.fechaActuacion || '').trim();
    const maxParam = req.query.max ?? req.query.maximoEntradas;
    const max = parseInt(String(maxParam ?? '').trim(), 10);

    if (!desc)     return res.status(400).json({ error: 'Falta desc/descripcionProducto' });
    if (!fechaStr) return res.status(400).json({ error: 'Falta fecha/fechaActuacion' });
    if (!Number.isFinite(max) || max < 1) return res.status(400).json({ error: 'max/maximoEntradas inválido' });

    const carpeta = `entradas/${normalizar(desc)}/`;

    const vendidas = await contarPdfs(carpeta);
    const restantes = Math.max(0, max - vendidas);

    const ahora   = dayjs().tz(TZ);
    const evento  = dayjs.tz(fechaStr, 'DD/MM/YYYY - HH:mm', TZ, true); // estricto
    const porFecha = evento.isValid() ? evento.isBefore(ahora) : false;
    const porCupo  = vendidas >= max;

    const abierta = !(porFecha || porCupo);
    const motivo  = porCupo ? 'agotadas' : porFecha ? 'cerrada_por_fecha' : 'abierta';

    return res.json({
      ok: true,
      desc,
      carpeta,
      vendidas,
      maximo: max,
      restantes,
      abierta,
      motivo,
      ahora: ahora.format('YYYY-MM-DD HH:mm'),
      evento: evento.isValid() ? evento.format('YYYY-MM-DD HH:mm') : null,
    });
  } catch (e) {
    console.error('❌ /entradas/estado:', e?.message || e);
    return res.status(500).json({ error: 'Error calculando estado' });
  }
});

module.exports = router;
