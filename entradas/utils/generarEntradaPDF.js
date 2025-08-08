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

  // ✅ Imagen con proporción real
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  let imagenHeight = 0;

  try {
    const response = await fetch(urlFondo);
    const inputBuffer = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(inputBuffer).metadata();

    const renderWidth = doc.page.width;
    const scale = renderWidth / metadata.width;
    imagenHeight = metadata.height * scale;

    const resizedImage = await sharp(inputBuffer)
      .resize({ width: Math.round(renderWidth) })
      .png()
      .toBuffer();

    doc.image(resizedImage, 0, 0, { width: renderWidth });
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // ✅ QR dentro de la imagen
  const qrSize = 150;
  const qrX = 50;
  const qrY = 50;
  const qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`);

  // Fondo blanco QR
  doc.fillColor('white').rect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20).fill();
  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // ✅ Código con margen y subrayado ajustado al texto
  const codigoTexto = `Código: ${codigo}`;
  const codigoFontSize = 18;
  const paddingX = 6;
  const paddingY = 4;

  const textWidth = doc.widthOfString(codigoTexto, {
    font: 'Helvetica-Bold',
    size: codigoFontSize
  });
  const textHeight = doc.currentLineHeight();

  const codigoX = qrX;
  const codigoY = qrY + qrSize + 20;

  doc.fillColor('white')
    .rect(codigoX - paddingX, codigoY - paddingY, textWidth + 2 * paddingX, textHeight + 2 * paddingY)
    .fill();

  doc.fillColor('black')
    .font('Helvetica-Bold')
    .fontSize(codigoFontSize)
    .text(codigoTexto, codigoX, codigoY);

  // ✅ Textos debajo de la imagen
  let textY = imagenHeight + 40;
  const textX = 50;
  const lineSpacing = 28;

  doc.fillColor('black').font('Helvetica-Bold').fontSize(16).text('Entrada para:', textX, textY);
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
