// /entradas/services/generarEntradasPDF.js
// 

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const fs = require('fs/promises');
const path = require('path');

async function generarEntradaPDF({
  nombre,
  apellidos,
  codigo,
  nombreActuacion,
  fechaActuacion,
  imagenFondo
}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));

  if (imagenFondo && imagenFondo.startsWith('http')) {
    try {
      const fondoData = await fetch(imagenFondo).then(r => r.arrayBuffer());
      const fondoPath = path.join(__dirname, `../../temp_fondo_${codigo}.jpg`);
      await fs.writeFile(fondoPath, Buffer.from(fondoData));
      doc.image(fondoPath, 0, 0, { width: 595.28, height: 841.89 });
      await fs.unlink(fondoPath);
    } catch (err) {
      console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
    }
  }

  const nombreCompleto = `${nombre} ${apellidos}`.trim();
  const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
  const qrImage = await QRCode.toBuffer(qrData);

  doc.fontSize(18).text(`Entrada para: ${nombreCompleto}`, 50, 100);
  doc.fontSize(14).text(`Evento: ${nombreActuacion}`, 50, 140);
  doc.text(`Fecha: ${fechaActuacion}`, 50, 160);
  doc.text(`Código: ${codigo}`, 50, 200);
  doc.image(qrImage, 50, 240, { width: 120 });

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
