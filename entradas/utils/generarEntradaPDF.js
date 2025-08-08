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

  // ✅ Imagen de fondo con proporción
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

  // ✅ QR
  const qrSize = 150;
  const qrX = 50;
  const qrY = 50;
  const qrPadding = 10;
  const qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`);

  // Fondo blanco justo detrás del QR con menos margen
  doc.fillColor('white')
    .rect(qrX - qrPadding, qrY - qrPadding, qrSize + 2 * qrPadding, qrSize + 2 * qrPadding)
    .fill();

  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // ✅ Código más separado, con subrayado alineado exacto al fondo del QR
  const codigoFontSize = 16;
  const codigoTexto = `Código: ${codigo}`;
  const codigoY = qrY + qrSize + 30; // antes 20 → ahora 30 para más separación

  doc.fillColor('black')
    .font('Helvetica-Bold')
    .fontSize(codigoFontSize);

  const textWidth = doc.widthOfString(codigoTexto);
  const textHeight = doc.currentLineHeight();

  // Subrayado exacto al ancho del QR + padding
  const underlineWidth = qrSize + 2 * qrPadding;
  const underlineHeight = textHeight + 8;

  doc.fillColor('white')
    .rect(qrX - qrPadding, codigoY - 5, underlineWidth, underlineHeight)
    .fill();

  doc.fillColor('black')
    .text(codigoTexto, qrX, codigoY);

  // ✅ Textos informativos debajo de la imagen
  let textY = imagenHeight + 40;
  const textX = 50;
  const lineSpacing = 28;

  doc.fillColor('black')
    .font('Helvetica-Bold')
    .fontSize(16)
    .text('Entrada para:', textX, textY);

  textY += lineSpacing;

  doc.font('Helvetica')
    .text(fechaActuacion, textX, textY);
  textY += lineSpacing;

  doc.font('Helvetica-Bold')
    .text(descripcionProducto, textX, textY);
  textY += lineSpacing;

  doc.font('Helvetica')
    .text(direccionEvento, textX, textY);

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

  // ✅ SEPARADOR HORIZONTAL
  textY += 40;
  doc.moveTo(50, textY).lineTo(doc.page.width - 50, textY).lineWidth(1).strokeColor('#888').stroke();
  textY += 30;

  // ✅ TEXTOS DE PUBLICIDAD
  doc.fillColor('black')
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('SIN COMPROMISO DE PERMANENCIA', 50, textY);
  textY += 24;

  doc.fontSize(14).text('9,99 EUROS AL MES', 50, textY);
  textY += 24;

  doc.text('ACCESO A CONTENIDO EXCLUSIVO:', 50, textY);
  textY += 24;

  const bulletItems = [
    'VÍDEOS EXCLUSIVOS',
    'PODCAST “TE LO HAS CURRADO”',
    'ARTÍCULOS EXCLUSIVOS',
    'NOTICIAS',
    'SENTENCIAS'
  ];

  doc.font('Helvetica');
  bulletItems.forEach(item => {
    doc.text(`• ${item}`, 65, textY);
    textY += 20;
  });

  // ✅ IMAGEN DEL CLUB
  try {
    const clubImgURL = 'https://www.laboroteca.es/wp-content/uploads/2025/08/CLUB-LABOROTECA-scaled.jpg';
    const imgRes = await fetch(clubImgURL);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const imgWidth = doc.page.width - 100; // margen lateral
    const imgX = 50;
    const imgY = textY + 20;

    doc.image(imgBuffer, imgX, imgY, { width: imgWidth });
  } catch (err) {
    console.warn('⚠️ No se pudo cargar imagen CLUB LABOROTECA:', err.message);
  }


module.exports = { generarEntradaPDF };
