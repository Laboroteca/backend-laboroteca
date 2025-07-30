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

function generarCodigoUnico(slugEvento) {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const random = () =>
    letras[Math.floor(Math.random() * letras.length)] +
    letras[Math.floor(Math.random() * letras.length)] +
    Math.floor(100 + Math.random() * 899);
  return `${slugEvento.toUpperCase().slice(0, 3)}-${random()}`;
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

const HOJAS_EVENTO = {
  '22': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  '25': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  '28': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  '31': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  '34': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
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
  if (!spreadsheetId) throw new Error('🟥 No se reconoce el ID del formulario para asociar hoja');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const entradas = [];

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

    if (imagenFondo) {
      try {
        const fondoData = await fetch(imagenFondo).then(r => r.arrayBuffer());
        const fondoPath = path.join(__dirname, `../../temp_fondo_${codigo}.jpg`);
        await fs.writeFile(fondoPath, Buffer.from(fondoData));
        pdf.image(fondoPath, 0, 0, { width: 595.28, height: 841.89 });
        await fs.unlink(fondoPath);
      } catch (err) {
        console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}`);
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

    // Subida a GCS
    const nombreArchivo = `entradas/${slugEvento}/${codigo}.pdf`;
    await bucket.file(nombreArchivo).save(pdfBuffer);
    console.log(`✅ Entrada subida a GCS: ${nombreArchivo}`);

    // Registro en hoja del evento
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A2',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [
          [fechaVenta, nombreCompleto, i + 1, codigo, 'NO']
        ]
      }
    });

    // Firebase
    await firestore.collection('entradas').doc(codigo).set({
      codigo,
      email,
      nombre: asistente.nombre,
      apellidos: asistente.apellidos,
      slugEvento,
      fechaEvento,
      descripcionProducto,
      usada: false,
      timestamp: Date.now()
    });

    entradas.push({ codigo, nombreArchivo, buffer: pdfBuffer });
  }

  return entradas;
}

module.exports = generarEntradas;
