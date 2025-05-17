const { Storage } = require('@google-cloud/storage');
const path = require('path');

// Cargar credenciales desde base64 o archivo físico
let credentials;
if (process.env.GOOGLE_CREDENTIALS_JSON_BASE64) {
  try {
    credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_CREDENTIALS_JSON_BASE64, 'base64').toString('utf8')
    );
    console.log('🔐 Credenciales GCS cargadas desde variable de entorno');
  } catch (err) {
    console.error('❌ Error al parsear GOOGLE_CREDENTIALS_JSON_BASE64:', err);
    throw err;
  }
} else {
  credentials = require(path.join(__dirname, '../google/credenciales-sheets.json'));
  console.log('📄 Credenciales GCS cargadas desde archivo físico');
}

// Inicializar almacenamiento
const storage = new Storage({ credentials });
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
