// routes/micuentaFacturas.js
const express = require('express');
const router = express.Router();

const admin = require('../firebase');
const firestore = admin.firestore();

const { Storage } = require('@google-cloud/storage');
const axios = require('axios');
const qs = require('qs');

// ====== Config externa FacturaCity (para fallback de PDF si no está en GCS)
const FACTURACITY_API_KEY = process.env.FACTURACITY_API_KEY?.trim().replace(/"/g, '');
const API_BASE = process.env.FACTURACITY_API_URL;
const AXIOS_TIMEOUT = 10000;

// ====== GCS
const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64 || '', 'base64').toString('utf8')
  ),
});
const bucket = storage.bucket('laboroteca-facturas');

// ====== Email (nuevo servicio para enviar varias facturas adjuntas)
const { enviarEmailConFacturas } = require('../services/enviarEmailConFacturas');

// ---------- Utils de paginación ----------
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(s) {
  try { return JSON.parse(Buffer.from(String(s || ''), 'base64url').toString('utf8')); }
  catch { return null; }
}

// ---------- Descarga de PDF (GCS o fallback FacturaCity) ----------
async function descargarFacturaPdf({ storagePath, idfactura, numeroFactura }) {
  // 1) Si tenemos storagePath en GCS, lo usamos
  if (storagePath) {
    const [exists] = await bucket.file(storagePath).exists();
    if (exists) {
      const [buf] = await bucket.file(storagePath).download();
      const filename = (storagePath.split('/').pop()) || `factura-${numeroFactura || idfactura || Date.now()}.pdf`;
      return { buffer: buf, filename };
    }
  }
  // 2) Fallback: exportar desde FacturaCity (requiere idfactura)
  if (idfactura && API_BASE && FACTURACITY_API_KEY) {
    const url = `${API_BASE}/exportarFacturaCliente/${idfactura}?lang=es_ES`;
    const resp = await axios.get(url, {
      headers: { Token: FACTURACITY_API_KEY },
      responseType: 'arraybuffer',
      timeout: AXIOS_TIMEOUT
    });
    const filename = `factura-${numeroFactura || idfactura}.pdf`;
    return { buffer: resp.data, filename };
  }
  return null;
}

// ========== LISTADO: GET /cuenta/facturas?email=...&pageSize=15&cursor=... ==========
router.get('/cuenta/facturas', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Falta email' });

    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '15'), 10) || 15, 1), 50);
    const cursorRaw = req.query.cursor ? decodeCursor(req.query.cursor) : null;

    // Paginación robusta: orderBy(fechaISO desc, __name__ desc)
    let q = firestore
      .collection('facturas')
      .where('email', '==', email)
      .orderBy('fechaISO', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
      .limit(pageSize + 1); // pedimos 1 extra para saber si hay más

    if (cursorRaw && cursorRaw.fechaISO && cursorRaw.docId) {
      q = q.startAfter(cursorRaw.fechaISO, cursorRaw.docId);
    }

    const snap = await q.get();

    const items = [];
    snap.forEach(doc => {
      const d = doc.data() || {};
      items.push({
        docId: doc.id,
        fechaISO: d.fechaISO || null,
        fecha: d.fechaTexto || (d.fechaISO ? new Date(d.fechaISO).toLocaleDateString('es-ES') : ''),
        numeroFactura: d.numeroFactura || d.idfactura || d.invoiceId || '',
        descripcionProducto: d.descripcionProducto || d.nombreProducto || '',
        importeConIVA: (typeof d.importeTotalIVA === 'number') ? d.importeTotalIVA : null,
        idfactura: d.idfactura || null,
        storagePath: d.storagePath || null
      });
    });

    let hasMore = false;
    let nextCursor = null;
    if (items.length > pageSize) {
      const last = items[pageSize - 1];
      hasMore = true;
      nextCursor = encodeCursor({ fechaISO: last.fechaISO || '', docId: last.docId });
      items.length = pageSize;
    }

    return res.json({ ok: true, items, hasMore, cursor: nextCursor });
  } catch (e) {
    console.error('❌ GET /cuenta/facturas', e);
    return res.status(500).json({ error: 'Error listando facturas' });
  }
});

// ========== REENVÍO: POST /facturas/reenviar ==========
/*
Body JSON:
{
  "emailDestino": "destino@ejemplo.com",
  "emailUsuario": "dueño@ejemplo.com",
  "ids": ["docId1", "docId2", ...]     // docIds de colección 'facturas'
}
*/
router.post('/facturas/reenviar', async (req, res) => {
  try {
    const body = req.body || {};
    const to = String(body.emailDestino || '').trim().toLowerCase();
    const owner = String(body.emailUsuario || '').trim().toLowerCase();
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];

    if (!to || !owner || ids.length === 0) {
      return res.status(400).json({ error: 'Faltan campos: emailDestino, emailUsuario, ids[]' });
    }

    // Seguridad básica: sólo permite reenviar facturas del owner
    const reads = await Promise.all(ids.map(id => firestore.collection('facturas').doc(id).get()));
    const validDocs = reads
      .filter(s => s.exists)
      .map(s => ({ id: s.id, ...s.data() }))
      .filter(d => (d.email || '').toLowerCase() === owner);

    if (validDocs.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado facturas del usuario' });
    }

    // Cargar buffers (GCS → fallback FacturaCity)
    const adjuntos = [];
    for (const d of validDocs) {
      const pdf = await descargarFacturaPdf({
        storagePath: d.storagePath || d.nombreArchivo || null,
        idfactura: d.idfactura || null,
        numeroFactura: d.numeroFactura || null
      });
      if (pdf && pdf.buffer?.length) {
        adjuntos.push(pdf);
      }
    }
    if (adjuntos.length === 0) {
      return res.status(404).json({ error: 'No se pudieron localizar PDFs de las facturas seleccionadas' });
    }

    await enviarEmailConFacturas({
      email: to,
      nombre: owner,
      facturas: adjuntos, // [{buffer, filename}]
      count: adjuntos.length
    });

    return res.json({ ok: true, reenviadas: adjuntos.length });
  } catch (e) {
    console.error('❌ POST /facturas/reenviar', e);
    return res.status(500).json({ error: 'Error reenviando facturas' });
  }
});

// GET defensivo
router.get('/facturas/reenviar', (_req, res) => {
  res.status(405).json({ error: 'Usa método POST con JSON' });
});

module.exports = router;
