const { Storage } = require('@google-cloud/storage');
const { alertAdmin } = require('../utils/alertAdmin');


// Carga y decodifica las credenciales desde la variable de entorno
const credentialsJSON = JSON.parse(
  Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf-8')
);

// Inicializa el cliente de Storage con las credenciales
const storage = new Storage({ credentials: credentialsJSON });

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
      // Aviso admin (callback no async: sin await)
      alertAdmin({
        area: 'gcs_subida_factura',
        email: '-', // aquí no tenemos email; el caller lo conoce
        err,
        meta: {
          file: __filename,
          bucket: BUCKET_NAME,
          nombreArchivo,
          pdfBytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined
        }
      });
      throw err;
    });


    stream.on('finish', () => {
      console.log(`✅ Factura subida a Google Cloud Storage como: ${nombreArchivo}`);
    });

    stream.end(pdfBuffer);
  } catch (err) {
    console.error('❌ Error en subirFactura:', err);
    // Aviso admin (aquí sí podemos await)
    await alertAdmin({
      area: 'gcs_subida_factura_wrapper',
      email: '-', // el email lo aporta el servicio llamante
      err,
      meta: {
        file: __filename,
        bucket: BUCKET_NAME,
        nombreArchivo,
        esBuffer: Buffer.isBuffer(pdfBuffer),
        pdfBytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined
      }
    });
    throw err;
  }

}

module.exports = { subirFactura };
