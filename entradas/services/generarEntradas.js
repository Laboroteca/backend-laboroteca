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
// Mantienes el 22 y cambias el resto a 39, 40, 41, (y el último lo pongo como 42).
// Si realmente el último también es 41, sustituye '42' por el ID correcto.
const HOJAS_EVENTO = {
  '22': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s', // Formulario 1 (ID 22)
  '39': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM', // antes 25
  '40': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE', // antes 28
  '41': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM', // antes 31
  '42': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'  // antes 34  ← cámbialo si el último ID es 41 también
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
  const bucket = storage.bucket('laboroteca-facturas');

  const spreadsheetId = HOJAS_EVENTO[idFormulario?.toString()];
  if (!spreadsheetId) {
    throw new Error('🟥 No se reconoce el ID del formulario para asociar hoja');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const entradas = [];

  // Carpeta de GCS basada en descripciónProducto (no en nombre/slug del evento)
  // Ej.: entradas/jornadas-madrid-18-10-2025/ABC-123.pdf
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

    // ───────── Subida a GCS (usa descripcionProducto como carpeta) ─────────
    const nombreArchivo = `entradas/${carpetaEvento}/${codigo}.pdf`;
    await bucket.file(nombreArchivo).save(pdfBuffer);
    console.log(`✅ Entrada subida a GCS: ${nombreArchivo}`);

    // ───────── Registro en Google Sheets ─────────
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
      console.error(`❌ Error registrando en Google Sheets entrada ${codigo}:`, err.message);
    }

// ───────── Registro en Firestore (dos colecciones) ─────────
try {
  // 1) Colección principal (compat)
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

  // 2) Colección usada por “Mi cuenta”
  await firestore.collection('entradasCompradas').doc(codigo).set({
    codigo,
    emailComprador: email,
    // nombre del evento en todos los sabores
    nombreEvento: descripcionProducto || slugEvento || 'Evento',
    descripcionProducto: descripcionProducto || '',
    slugEvento: slugEvento || '',
    // localización/fecha (para mostrar/filtrar)
    direccionEvento: direccionEvento || '',
    fechaEvento: fechaEvento || '',
    fechaActuacion: fechaEvento || '',
    usado: false,
    fechaCompra: new Date().toISOString()
  }, { merge: true });

} catch (err) {
  console.error(`❌ Error guardando en Firestore entrada ${codigo}:`, err.message);
}

    entradas.push({ codigo, nombreArchivo, buffer: pdfBuffer });
  }

  return entradas;
}

module.exports = generarEntradas;
