const { Storage } = require('@google-cloud/storage');

const storage = new Storage({
  credentials: JSON.parse(
    Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
  )
});

const bucket = storage.bucket('laboroteca-facturas');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/**
 * Sube una entrada en PDF a Google Cloud Storage
 * @param {string} nombreArchivo - Ruta dentro del bucket (ej. entradas/jub2025/CODIGO.pdf)
 * @param {Buffer} bufferPDF - Contenido del PDF
 * @returns {Promise<void>}
 */
async function subirEntrada(nombreArchivo, bufferPDF) {
  try {
    const file = bucket.file(nombreArchivo);
    await file.save(bufferPDF);
    console.log(`📂 Entrada subida a GCS: ${nombreArchivo}`);
  } catch (err) {
    console.error(`❌ Error subiendo entrada a GCS: ${err.message}`);
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
