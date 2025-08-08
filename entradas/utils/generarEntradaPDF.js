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

  // ✅ Imagen de fondo proporcional
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

    const resizedImage = await sharp(inputBuffer).resize({ width: Math.round(renderWidth) }).png().toBuffer();
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

  doc.fillColor('white')
    .rect(qrX - qrPadding, qrY - qrPadding, qrSize + 2 * qrPadding, qrSize + 2 * qrPadding)
    .fill();

  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // ✅ Código debajo del QR
  const codigoFontSize = 16;
  const codigoTexto = `Código: ${codigo}`;
  const codigoY = qrY + qrSize + 30;
  doc.font('Helvetica-Bold').fontSize(codigoFontSize);

  const underlineWidth = qrSize + 2 * qrPadding;
  const underlineHeight = doc.currentLineHeight() + 8;

  doc.fillColor('white')
    .rect(qrX - qrPadding, codigoY - 5, underlineWidth, underlineHeight)
    .fill();

  doc.fillColor('black').text(codigoTexto, qrX, codigoY);

  // ✅ Datos de entrada
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

  // ✅ SEPARADOR
  textY += 40;
  doc.moveTo(50, textY).lineTo(doc.page.width - 50, textY).lineWidth(1).strokeColor('#888').stroke();
  textY += 20;

  // ✅ "Publicidad" alineado derecha con borde
  const etiquetaTexto = 'Publicidad';
  const etiquetaFontSize = 10;
  doc.font('Helvetica-Bold').fontSize(etiquetaFontSize);

  const etiquetaWidth = doc.widthOfString(etiquetaTexto) + 12;
  const etiquetaHeight = doc.currentLineHeight() + 4;
  const etiquetaX = doc.page.width - 50 - etiquetaWidth;
  const etiquetaY = textY;

  doc.fillColor('white')
    .rect(etiquetaX, etiquetaY, etiquetaWidth, etiquetaHeight)
    .stroke('#444');

  doc.fillColor('black')
    .text(etiquetaTexto, etiquetaX + 6, etiquetaY + 2);

  textY += etiquetaHeight + 15;

  // ✅ Texto promocional
  const promoX = 50;
  const promoWidth = doc.page.width - 100;
  const intro1 = 'Si quieres acceder a contenido exclusivo sobre Derechos Laborales y Seguridad Social, puedes hacerte socio del ';
  const clubTexto = 'Club Laboroteca';
  const intro2 = ', por una cuota de 9,99 € y sin compromiso de permanencia.';

  doc.font('Helvetica-Bold').fontSize(12).fillColor('black')
    .text(intro1, promoX, textY, { width: promoWidth, continued: true });

  const clubLabelWidth = doc.widthOfString(clubTexto) + 20;
  const clubLabelX = doc.x;
  const clubLabelY = textY;

  doc.save()
    .moveTo(clubLabelX, clubLabelY + 16)
    .lineTo(clubLabelX + 10, clubLabelY)
    .lineTo(clubLabelX + clubLabelWidth - 10, clubLabelY)
    .lineTo(clubLabelX + clubLabelWidth, clubLabelY + 16)
    .lineTo(clubLabelX, clubLabelY + 16)
    .fill('#d4af37')
    .restore();

  doc.fillColor('black').fontSize(10)
    .text(clubTexto, clubLabelX + 10, clubLabelY + 2, {
      width: clubLabelWidth - 20,
      align: 'center'
    });

  textY = clubLabelY + 22;

  doc.font('Helvetica-Bold').fontSize(12)
    .text(intro2, promoX, textY, { width: promoWidth });

  // ✅ Bullets con emojis
  const bulletItems = [
    ['🎥', 'Vídeos exclusivos'],
    ['🎙️', 'Podcast “Te lo has currado”'],
    ['📄', 'Artículos exclusivos'],
    ['📰', 'Noticias y sentencias novedosas']
  ];

  doc.font('Helvetica');
  for (const [emoji, texto] of bulletItems) {
    textY += 24;
    doc.text(`${emoji} ${texto}`, promoX, textY, { width: promoWidth });
  }

  // ✅ Imagen promocional
  const clubImgURL = 'https://www.laboroteca.es/wp-content/uploads/2025/08/CLUB-LABOROTECA-scaled.jpg';

  try {
    const clubResponse = await fetch(clubImgURL);
    if (!clubResponse.ok) throw new Error(`Error ${clubResponse.status}`);
    const clubBuffer = Buffer.from(await clubResponse.arrayBuffer());

    const imgX = 50;
    const imgY = textY + 30;
    const imgWidth = doc.page.width - 100;

    doc.image(clubBuffer, imgX, imgY, { width: imgWidth });
  } catch (err) {
    console.warn('⚠️ No se pudo cargar la imagen del Club Laboroteca:', err.message);
  }

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
