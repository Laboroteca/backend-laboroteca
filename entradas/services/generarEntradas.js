//entradas/services/generarEntradas.js

const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');
const { Storage } = require('@google-cloud/storage');
const admin = require('../../firebase');
const firestore = admin.firestore();
const { google } = require('googleapis');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// Init GCS seguro (sin await top-level). Si falla, avisamos y usamos fallback ADC.
let storage;
try {
  const credsJson = Buffer.from(process.env.GCP_CREDENTIALS_BASE64 || '', 'base64').toString('utf8');
  const creds = JSON.parse(credsJson);
  storage = new Storage({ credentials: creds });
} catch (e) {
  console.error('❌ GCS credentials error:', e?.message || e);
  // Fire-and-forget (sin await top-level)
  alertAdmin({
    area: 'entradas.generar.gcs.creds',
    email: '-',
    err: e,
    meta: { hasEnv: !!process.env.GCP_CREDENTIALS_BASE64 }
  }).catch(() => {});
  // Fallback: intenta ADC (puede funcionar en GCP)
  storage = new Storage();
}

// ───────────────────────── Helpers ─────────────────────────
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function generarCodigoUnico(slugEvento) {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const random = () =>
    letras[Math.floor(Math.random() * letras.length)] +
    letras[Math.floor(Math.random() * letras.length)] +
    Math.floor(100 + Math.random() * 899);
  return `${String(slugEvento || 'EVT').toUpperCase().slice(0, 3)}-${random()}`;
}

function formatearFechaES() {
  return new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ───────────────────────── Mapear formulario→Sheet ─────────────────────────
const HOJAS_EVENTO = {
  '22': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc',
};

async function generarEntradas({
  email,
  nombre,
  apellidos,
  asistentes = [],
  numEntradas = 1,
  slugEvento,
  fechaEvento,
  direccionEvento,
  descripcionProducto,
  imagenFondo,
  idFormulario,
}) {
  const bucket = storage.bucket('laboroteca-facturas');

  const spreadsheetId = HOJAS_EVENTO[idFormulario?.toString()] || null;
  if (!spreadsheetId) {
    console.warn('🟨 Sin spreadsheetId: se omite registro en Sheets para', idFormulario);
  }

  // Auth Sheets con alerta si falla
  let sheets = null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(
        Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
      ),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  } catch (e) {
    console.error('❌ Sheets auth error:', e?.message || e);
    try {
      await alertAdmin({
        area: 'entradas.generar.sheetsAuth',
        email,
        err: e,
        meta: { idFormulario, spreadsheetId }
      });
    } catch (_) {}
  }

  const entradas = [];
  const errores = [];

  // Carpeta de GCS basada en descripciónProducto (no en nombre/slug del evento)
  const carpetaEvento = slugify(descripcionProducto || slugEvento || 'evento');

  for (let i = 0; i < numEntradas; i++) {
    const asistente = asistentes[i] || { nombre, apellidos };
    const codigo = generarCodigoUnico(slugEvento);
    const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
    // QR de alta resolución para nitidez en PDF
    const qrImage = await QRCode.toBuffer(qrData, {
      errorCorrectionLevel: 'H',
      type: 'png',
      width: 600,     // alta resolución
      margin: 1
    });
    const fechaVenta = formatearFechaES();
    const nombreCompleto = `${asistente.nombre} ${asistente.apellidos}`.trim();

    // Generar PDF (sin compresión para no degradar imágenes)
    const pdf = new PDFDocument({ size: 'A4', margin: 0, compress: false });
    const buffers = [];
    pdf.on('data', buffers.push.bind(buffers));

    // ── Fondo a toda página y cálculo de altura dibujada real ──
    let fondoDrawnH = 0;
    if (imagenFondo && imagenFondo.startsWith('http')) {
      try {
        const res = await fetch(imagenFondo);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fondoBuf = Buffer.from(await res.arrayBuffer());
        // Intenta leer metadatos para calcular escala real
        try {
          const sharp = require('sharp');
          const meta = await sharp(fondoBuf).metadata();
          const maxW = pdf.page.width;
          const maxH = pdf.page.height;
          const scale = Math.min(maxW / (meta.width || maxW), maxH / (meta.height || maxH));
          fondoDrawnH = Math.min(maxH, (meta.height || maxH) * scale);
        } catch {
          // Si no podemos leer metadatos, asumimos alto de página
          fondoDrawnH = pdf.page.height;
        }
        pdf.image(fondoBuf, 0, 0, { fit: [pdf.page.width, pdf.page.height] });
      } catch (err) {
        console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
      }
    }

    // ── Zona superior segura para no forzar salto de página ──
    const baseY = (function () {
      // Coloca el texto bajo el fondo, pero nunca más allá de un margen que rompa layout
      const y = (fondoDrawnH ? fondoDrawnH + 40 : 100);
      // cap inferior para fondos muy altos, y mínimo para fondos bajos
      return Math.max(100, Math.min(y, pdf.page.height - 360));
    })();

    pdf.fontSize(18).text(`Entrada para: ${nombreCompleto}`, 50, baseY);
    pdf.fontSize(14).text(`Evento: ${descripcionProducto}`, 50, baseY + 40);
    pdf.text(`Fecha: ${fechaEvento}`, 50, baseY + 60);
    pdf.text(`Dirección: ${direccionEvento}`, 50, baseY + 80);
    pdf.text(`Código: ${codigo}`, 50, baseY + 120);
    // Insertar QR reescalando hacia abajo (queda muy nítido)
    pdf.image(qrImage, 50, baseY + 160, { width: 120 });

    pdf.end();

    const pdfBuffer = await new Promise((resolve) =>
      pdf.on('end', () => resolve(Buffer.concat(buffers)))
    );

    // ───────── Subida a GCS ─────────
    const nombreArchivo = `entradas/${carpetaEvento}/${codigo}.pdf`;
    try {
      await bucket.file(nombreArchivo).save(pdfBuffer, {
        contentType: 'application/pdf',
        resumable: false,
        metadata: { cacheControl: 'private, max-age=0' }
      });
      console.log(`✅ Entrada subida a GCS: ${nombreArchivo}`);
    } catch (err) {
      console.error(`❌ Error GCS ${codigo}:`, err.message);
      // Aviso admin: fallo al subir PDF a GCS
      try {
        await alertAdmin({
          area: 'entradas.generar.gcs',
          email,
          err,
          meta: { codigo, nombreArchivo, carpetaEvento, idFormulario, descripcionProducto }
        });
      } catch (_) {}
      errores.push({
        paso: 'GCS',
        codigo,
        detalle: err.message,
        motivo: 'No se han subido las entradas en GCS',
      });
    }

    // ───────── Registro en Google Sheets (opcional) ─────────
    if (spreadsheetId && sheets) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'A2',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [[fechaVenta, descripcionProducto, nombreCompleto, i + 1, codigo, 'NO']],
          },
        });
      } catch (err) {
        console.error(`❌ Error Sheets ${codigo}:`, err.message);
        // Aviso admin: fallo al registrar en Google Sheets
        try {
          await alertAdmin({
            area: 'entradas.generar.sheets',
            email,
            err,
            meta: {
              codigo,
              spreadsheetId,
              fila: i + 1,
              fechaVenta,
              descripcionProducto,
              nombreCompleto
            }
          });
        } catch (_) {}
        errores.push({
          paso: 'SHEETS',
          codigo,
          detalle: err.message,
          motivo: 'No se ha registrado la venta en Google Sheets',
        });
      }
    } else if (spreadsheetId && !sheets) {
      // Si había sheetId pero no pudimos inicializar Sheets, anota error “amigable”
      errores.push({
        paso: 'SHEETS',
        codigo,
        detalle: 'No se pudo inicializar Google Sheets',
        motivo: 'Auth Sheets fallida'
      });
    }

    // ───────── Registro en Firestore (best-effort) ─────────
    try {
      await firestore.collection('entradas').doc(codigo).set(
        {
          codigo,
          email, // comprador
          emailComprador: email, // alias por compatibilidad
          nombre: asistente.nombre || '',
          apellidos: asistente.apellidos || '',
          slugEvento, // ej. "presentacion-del-libro..."
          nombreEvento: descripcionProducto || slugEvento || 'Evento',
          descripcionProducto: descripcionProducto || '',
          direccionEvento: direccionEvento || '',
          fechaEvento: fechaEvento || '', // formato "DD/MM/YYYY - HH:mm"
          fechaActuacion: fechaEvento || '', // duplicado para búsquedas
          nEntrada: i + 1,
          usada: false,
          fechaCompra: new Date().toISOString(),
          timestamp: Date.now(),
        },
        { merge: true }
      );

      await firestore.collection('entradasCompradas').doc(codigo).set(
        {
          codigo,
          emailComprador: email,
          nombreEvento: descripcionProducto || slugEvento || 'Evento',
          descripcionProducto: descripcionProducto || '',
          slugEvento: slugEvento || '',
          direccionEvento: direccionEvento || '',
          fechaEvento: fechaEvento || '',
          fechaActuacion: fechaEvento || '',
          usado: false,
          fechaCompra: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (err) {
      console.error(`❌ Error guardando en Firestore entrada ${codigo}:`, err.message);
      // Aviso admin: fallo al registrar en Firestore
      try {
        await alertAdmin({
          area: 'entradas.generar.firestore',
          email,
          err,
          meta: {
            codigo,
            colecciones: ['entradas', 'entradasCompradas'],
            slugEvento,
            descripcionProducto
          }
        });
      } catch (_) {}
      errores.push({
        paso: 'FIRESTORE',
        codigo,
        detalle: err.message,
        motivo: 'No se ha registrado la venta en Firebase (Firestore)',
      });
    }

    entradas.push({ codigo, nombreArchivo, buffer: pdfBuffer });
  }

  // Contexto para emails de alerta (no rompe compat: los callers pueden ignorarlo)
  const contexto = {
    usuario: email,
    formularioId: idFormulario || '',
    evento: {
      slugEvento: slugEvento || '',
      descripcionProducto: descripcionProducto || '',
      fechaActuacion: fechaEvento || '',
      lugar: direccionEvento || '',
      carpetaGCS: carpetaEvento,
    },
    codigos: entradas.map((e) => e.codigo),
  };

  return { entradas, errores, contexto };
}

module.exports = generarEntradas;
