// services/gcs.js
'use strict';

const { Storage } = require('@google-cloud/storage');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// ───────────────── Config ─────────────────
const BUCKET_NAME = process.env.GCS_BUCKET_FACTURAS || 'laboroteca-facturas';
const STRICT_WRITES = String(process.env.GCS_STRICT_WRITES || '').trim() === '1';   // ifGenerationMatch:0
const VERIFY_UPLOAD = String(process.env.GCS_VERIFY_UPLOAD || '').trim() === '1';   // getMetadata & comparar tamaño

// ───────────── Credenciales GCP ─────────────
let credentialsJSON;
try {
  const b64 = process.env.GCP_CREDENTIALS_BASE64 || '';
  credentialsJSON = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
} catch (e) {
  throw new Error('❌ GCP_CREDENTIALS_BASE64 no está definida o no es JSON válido.');
}

const storage = new Storage({ credentials: credentialsJSON });

// ───────────── Utilidades ─────────────
const sanitizePath = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\.\./g, '');

function isReasonablePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 1000; // ~mínimo razonable
}

/**
 * Sube un PDF a Google Cloud Storage (awaitable).
 * Lanza si falla y avisa al admin (con el email afectado si se aporta).
 *
 * @param {string} nombreArchivo - Ruta/nombre único, p.ej. "facturas/abc/123.pdf"
 * @param {Buffer} pdfBuffer - Contenido PDF
 * @param {Object} [meta] - Metadatos opcionales (p.ej. { email, nombreProducto, importe })
 * @returns {Promise<{ bucket:string, name:string, gsUri:string, size:number }>}
 */
async function subirFactura(nombreArchivo, pdfBuffer, meta = {}) {
  const emailAfectado = (meta?.email || '-').toString();

  try {
    // Validaciones
    if (!isReasonablePdf(pdfBuffer)) {
      const err = new Error('PDF inválido o demasiado pequeño.');
      // Aviso inmediato con contexto
      await alertAdmin({
        area: 'gcs_subida_factura_validacion',
        email: emailAfectado,
        err,
        meta: {
          bucket: BUCKET_NAME,
          nombreArchivo,
          esBuffer: Buffer.isBuffer(pdfBuffer),
          pdfBytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined,
        },
      });
      throw err;
    }
    if (!nombreArchivo || typeof nombreArchivo !== 'string') {
      const err = new Error('nombreArchivo inválido.');
      await alertAdmin({
        area: 'gcs_subida_factura_validacion',
        email: emailAfectado,
        err,
        meta: { bucket: BUCKET_NAME, nombreArchivo: String(nombreArchivo) },
      });
      throw err;
    }

    const safeName = sanitizePath(nombreArchivo);
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(safeName);

    // Escritura awaitable con verificación de integridad
    await file.save(pdfBuffer, {
      resumable: false,             // PDFs pequeños/medianos → más simple y rápido
      validation: 'crc32c',         // checksum de integridad
      contentType: 'application/pdf',
      metadata: {
        contentDisposition: 'attachment; filename="Factura Laboroteca.pdf"',
        cacheControl: 'private, max-age=0, no-transform',
        // Puedes incluir metadatos que te ayuden a auditar:
        metadata: {
          email: emailAfectado,
          nombreProducto: meta?.nombreProducto || '',
          tipoProducto: meta?.tipoProducto || '',
          importe: typeof meta?.importe === 'number' ? String(meta.importe) : (meta?.importe || ''),
        },
      },
      ...(STRICT_WRITES ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
    });

    // Verificación opcional (tamaño en bytes)
    if (VERIFY_UPLOAD) {
      try {
        const [gmeta] = await file.getMetadata();
        const sizeOnGcs = Number(gmeta?.size || 0);
        if (sizeOnGcs !== pdfBuffer.length) {
          const err = new Error(`Tamaño en GCS (${sizeOnGcs}) no coincide con el buffer (${pdfBuffer.length}).`);
          await alertAdmin({
            area: 'gcs_verificacion_tamano',
            email: emailAfectado,
            err,
            meta: { bucket: BUCKET_NAME, nombreArchivo: safeName, sizeOnGcs, sizeBuffer: pdfBuffer.length },
          });
          throw err;
        }
      } catch (verErr) {
        // Si falla la verificación, avisa y relanza
        await alertAdmin({
          area: 'gcs_verificacion_error',
          email: emailAfectado,
          err: verErr,
          meta: { bucket: BUCKET_NAME, nombreArchivo: safeName },
        });
        throw verErr;
      }
    }

    const gsUri = `gs://${BUCKET_NAME}/${safeName}`;
    console.log(`✅ Factura subida a GCS: ${gsUri}`);

    return { bucket: BUCKET_NAME, name: safeName, gsUri, size: pdfBuffer.length };
  } catch (err) {
    console.error('❌ Error en subirFactura:', err?.message || err);

    // Aviso consolidado al admin (incluye email del cliente afectado)
    try {
      await alertAdmin({
        area: 'gcs_subida_factura',
        email: emailAfectado,
        err,
        meta: {
          bucket: BUCKET_NAME,
          nombreArchivo: nombreArchivo || '',
          esBuffer: Buffer.isBuffer(pdfBuffer),
          pdfBytes: Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : undefined,
        },
      });
    } catch (_) {
      // si falla el aviso, no interrumpas más
    }

    throw err;
  }
}

module.exports = { subirFactura };
