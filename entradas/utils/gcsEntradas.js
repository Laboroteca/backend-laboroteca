// /entradas/utils/gcsEntradas.js
'use strict';

const { Storage } = require('@google-cloud/storage');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

let storage, bucket;

try {
  const credsJson = Buffer.from(process.env.GCP_CREDENTIALS_BASE64 || '', 'base64').toString('utf8');
  const creds = JSON.parse(credsJson);
  storage = new Storage({ credentials: creds });
  bucket = storage.bucket('laboroteca-facturas');
} catch (e) {
  console.error('❌ Error inicializando GCS para entradas');
  // Aviso no bloqueante (dedupe via alertAdminProxy)
  try {
    alertAdmin({
      area: 'entradas.gcs.init',
      email: '-',
      err: e,
      meta: { hasEnv: !!process.env.GCP_CREDENTIALS_BASE64 }
    });
  } catch (_) {}
  // bucket quedará undefined → fallo controlado en subirEntrada
}

/**
 * Sube una entrada en PDF a Google Cloud Storage
 * @param {string} nombreArchivo - Ruta dentro del bucket (ej. entradas/jub2025/CODIGO.pdf)
 * @param {Buffer} bufferPDF - Contenido del PDF
 * @returns {Promise<void>}
 */
async function subirEntrada(nombreArchivo, bufferPDF) {
  if (!bucket) {
    const err = new Error('Bucket no inicializado en GCS (entradas)');
    console.error('❌', err.message);
    try {
      await alertAdmin({
        area: 'entradas.gcs.no_bucket',
        email: '-',
        err,
        meta: { nombreArchivo }
      });
    } catch (_) {}
    throw err;
  }

  try {
    const file = bucket.file(nombreArchivo);
    await file.save(bufferPDF, {
      resumable: false, // PDFs pequeños, evitamos sesión resumida
      contentType: 'application/pdf',
      metadata: { cacheControl: 'no-store' }
    });
    console.log('📂 Entrada subida a GCS');
  } catch (err) {
    console.error('❌ Error subiendo entrada a GCS');
    try {
      await alertAdmin({
        area: 'entradas.gcs.subida',
        err,
        meta: { nombreArchivo }
      });
    } catch (_) {}
    throw err;
  }
}

module.exports = { subirEntrada };
