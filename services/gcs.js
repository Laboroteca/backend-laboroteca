const { Storage } = require('@google-cloud/storage');

// Si estás en Railway con integración a Google Cloud activada, no hace falta pasar credenciales manualmente.
const storage = new Storage(); 
const BUCKET_NAME = 'laboroteca-facturas';

/**
 * Sube un PDF a Google Cloud Storage
 * @param {string} nombreArchivo - Nombre único del archivo PDF
 * @param {Buffer} pdfBuffer - Contenido en buffer del PDF
 */
async function subirFactura(nombreArchivo, pdfBuffer) {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(nombreArchivo);

    const stream = file.createWriteStream({
      metadata: {
        contentType: 'application/pdf',
      },
    });

    stream.on('error', (err) => {
      console.error('❌ Error subiendo a GCS:', err);
      throw err;
    });

    stream.on('finish', () => {
      console.log(`✅ Factura subida a Google Cloud Storage como: ${nombreArchivo}`);
    });

    stream.end(pdfBuffer);
  } catch (err) {
    console.error('❌ Error en subirFactura:', err);
    throw err;
  }
}

module.exports = { subirFactura };
