const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const sharp = require('sharp');

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

  // Fondo completo sin deformar
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  try {
    const response = await fetch(urlFondo);
    const inputBuffer = Buffer.from(await response.arrayBuffer());
    const pngBuffer = await sharp(inputBuffer).png().toBuffer();
    const metadata = await sharp(pngBuffer).metadata();

    const scale = Math.min(doc.page.width / metadata.width, doc.page.height / metadata.height);
    const renderWidth = metadata.width * scale;
    const renderHeight = metadata.height * scale;
    const x = (doc.page.width - renderWidth) / 2;
    const y = (doc.page.height - renderHeight) / 2;

    doc.image(pngBuffer, x, y, { width: renderWidth, height: renderHeight });
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // 📌 QR
  const qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`);
  const qrX = 50;
  const qrY = 100;
  const qrSize = 200;
  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // 📌 Código debajo del QR
  doc.fillColor('black')
    .font('Helvetica-Bold')
    .fontSize(16)
    .text(`Código: ${codigo}`, qrX, qrY + qrSize + 10);

  // 📌 Textos informativos encima de la imagen, alineados a la izquierda
  let textX = 50;
  let textY = 360;
  const lineSpacing = 28;

  doc.fontSize(16).font('Helvetica-Bold').text(`Entrada para:`, textX, textY);
  textY += lineSpacing;

  doc.font('Helvetica').text(fechaActuacion, textX, textY);
  textY += lineSpacing;

  doc.font('Helvetica-Bold').text(descripcionProducto, textX, textY);
  textY += lineSpacing;

  doc.font('Helvetica').text(direccionEvento, textX, textY);

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
