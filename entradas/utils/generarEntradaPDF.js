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
  descripcionProducto,
  direccionEvento,
  imagenFondo
}) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));

  // Imagen de fondo (JPG por defecto si no se pasa imagenFondo)
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-scaled.jpg';

  try {
    const fondoData = await fetch(urlFondo).then(r => r.arrayBuffer());
    const fondoPath = path.join(__dirname, `../../temp_fondo_${codigo}.jpg`);
    await fs.writeFile(fondoPath, Buffer.from(fondoData));
    doc.image(fondoPath, 0, 0, { width: 595.28, height: 841.89 });
    await fs.unlink(fondoPath);
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // Código QR
  const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
  const qrImage = await QRCode.toBuffer(qrData);

  // Colores y estilos
  const blanco = '#FFFFFF';
  const negro = '#000000';

  // Posiciones dentro del área blanca
  const startX = 200;
  let posY = 150;
  const lineSpacing = 30;

  doc.fillColor(negro).fontSize(16).font('Helvetica-Bold');
  doc.text(`Código: ${codigo}`, startX, posY);
  posY += lineSpacing;

  doc.text(`Entrada para:`, startX, posY);
  posY += lineSpacing;

  doc.font('Helvetica').text(fechaActuacion, startX, posY);
  posY += lineSpacing;

  doc.font('Helvetica-Bold').text(descripcionProducto, startX, posY);
  posY += lineSpacing;

  doc.font('Helvetica').text(direccionEvento, startX, posY);

  // Imagen del QR en la parte izquierda
  doc.image(qrImage, 50, 150, { width: 120 });

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
