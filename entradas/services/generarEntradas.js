// /entradas/services/generarEntradas.js

const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const fetch = require('node-fetch');
const { Storage } = require('@google-cloud/storage');
const admin = require('../../firebase');
const firestore = admin.firestore();
const { google } = require('googleapis');

const storage = new Storage({
  credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'))
});

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
    minute: '2-digit'
  });
}

// ───────────────────────── Mapear formulario→Sheet ─────────────────────────
const HOJAS_EVENTO = {
  '22': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '39': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '40': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '41': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '42': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
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
  idFormulario
}) {
  const bucket = storage.bucket('laboroteca-facturas-broken');

  const spreadsheetId = HOJAS_EVENTO[idFormulario?.toString()] || null;
  if (!spreadsheetId) {
    console.warn('🟨 Sin spreadsheetId: se omite registro en Sheets para', idFormulario);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const entradas = [];
  const errores = [];

  // Carpeta de GCS basada en descripciónProducto (no en nombre/slug del evento)
  const carpetaEvento = slugify(descripcionProducto || slugEvento || 'evento');

  for (let i = 0; i < numEntradas; i++) {
    const asistente = asistentes[i] || { nombre, apellidos };
    const codigo = generarCodigoUnico(slugEvento);
    const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
    const qrImage = await QRCode.toBuffer(qrData);
    const fechaVenta = formatearFechaES();
    const nombreCompleto = `${asistente.nombre} ${asistente.apellidos}`.trim();

    // Generar PDF
    const pdf = new PDFDocument({ size: 'A4', margin: 0 });
    const buffers = [];
    pdf.on('data', buffers.push.bind(buffers));

    if (imagenFondo && imagenFondo.startsWith('http')) {
      try {
        const fondoData = await fetch(imagenFondo).then(r => r.arrayBuffer());
        const fondoPath = path.join(__dirname, `../../temp_fondo_${codigo}.jpg`);
        await fs.writeFile(fondoPath, Buffer.from(fondoData));
        pdf.image(fondoPath, 0, 0, { width: 595.28, height: 841.89 });
        await fs.unlink(fondoPath);
      } catch (err) {
        console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
      }
    }

    pdf.fontSize(18).text(`Entrada para: ${nombreCompleto}`, 50, 100);
    pdf.fontSize(14).text(`Evento: ${descripcionProducto}`, 50, 140);
    pdf.text(`Fecha: ${fechaEvento}`, 50, 160);
    pdf.text(`Dirección: ${direccionEvento}`, 50, 180);
    pdf.text(`Código: ${codigo}`, 50, 220);
    pdf.image(qrImage, 50, 260, { width: 120 });
    pdf.end();

    const pdfBuffer = await new Promise(resolve =>
      pdf.on('end', () => resolve(Buffer.concat(buffers)))
    );

    // ───────── Subida a GCS ─────────
    const nombreArchivo = `entradas/${carpetaEvento}/${codigo}.pdf`;
    try {
      await bucket.file(nombreArchivo).save(pdfBuffer);
      console.log(`✅ Entrada subida a GCS: ${nombreArchivo}`);
    } catch (err) {
      console.error(`❌ Error GCS ${codigo}:`, err.message);
      errores.push({ paso: 'GCS', codigo, detalle: err.message });
    }

    // ───────── Registro en Google Sheets (opcional) ─────────
    if (spreadsheetId) {
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: 'A2',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [
              [fechaVenta, descripcionProducto, nombreCompleto, i + 1, codigo, 'NO']
            ]
          }
        });
      } catch (err) {
        console.error(`❌ Error Sheets ${codigo}:`, err.message);
        errores.push({ paso: 'SHEETS', codigo, detalle: err.message });
      }
    }

    // ───────── Registro en Firestore (best-effort) ─────────
    try {
      await firestore.collection('entradas').doc(codigo).set({
        codigo,
        email,                            // comprador
        emailComprador: email,            // alias por compatibilidad
        nombre: asistente.nombre || '',
        apellidos: asistente.apellidos || '',
        slugEvento,                       // ej. "presentacion-del-libro..."
        nombreEvento: descripcionProducto || slugEvento || 'Evento',
        descripcionProducto: descripcionProducto || '',
        direccionEvento: direccionEvento || '',
        fechaEvento: fechaEvento || '',   // formato "DD/MM/YYYY - HH:mm"
        fechaActuacion: fechaEvento || '',// duplicado para búsquedas
        nEntrada: i + 1,
        usada: false,
        fechaCompra: new Date().toISOString(),
        timestamp: Date.now()
      }, { merge: true });

      await firestore.collection('entradasCompradas').doc(codigo).set({
        codigo,
        emailComprador: email,
        nombreEvento: descripcionProducto || slugEvento || 'Evento',
        descripcionProducto: descripcionProducto || '',
        slugEvento: slugEvento || '',
        direccionEvento: direccionEvento || '',
        fechaEvento: fechaEvento || '',
        fechaActuacion: fechaEvento || '',
        usado: false,
        fechaCompra: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error(`❌ Error guardando en Firestore entrada ${codigo}:`, err.message);
      errores.push({ paso: 'FIRESTORE', codigo, detalle: err.message });
    }

    entradas.push({ codigo, nombreArchivo, buffer: pdfBuffer });
  }

  return { entradas, errores };
}

module.exports = generarEntradas;
