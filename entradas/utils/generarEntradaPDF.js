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

  // Imagen de fondo (mantener proporciones, centrada)
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  try {
    const response = await fetch(urlFondo);
    if (!response.ok) throw new Error(`Error ${response.status} al descargar la imagen`);

    const arrayBuffer = await response.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    const pngBuffer = await sharp(inputBuffer).png().toBuffer();
    const metadata = await sharp(pngBuffer).metadata();

    const imageWidth = metadata.width;
    const imageHeight = metadata.height;
    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
    const renderWidth = imageWidth * scale;
    const renderHeight = imageHeight * scale;

    const x = (pageWidth - renderWidth) / 2;
    const y = (pageHeight - renderHeight) / 2;

    doc.image(pngBuffer, x, y, { width: renderWidth, height: renderHeight });

    console.log(`✅ Imagen de fondo aplicada correctamente para ${codigo}`);
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // Generar QR
  const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
  const qrImage = await QRCode.toBuffer(qrData);

  // 🔲 FONDO BLANCO RECTANGULAR
  const boxX = 50;
  const boxY = 500;
  const boxWidth = 500;
  const boxHeight = 200;

  doc.rect(boxX, boxY, boxWidth, boxHeight).fillOpacity(0.9).fill('white');

  // Volver al modo normal de escritura
  doc.fillOpacity(1);

  // ⬇️ QR
  doc.image(qrImage, boxX + 20, boxY + 20, { width: 100 });

  // ⬇️ Texto debajo del QR, alineado a la derecha del QR
  const textX = boxX + 140;
  let posY = boxY + 25;
  const lineSpacing = 25;

  doc.fillColor('black').fontSize(14).font('Helvetica-Bold');
  doc.text(`Código: ${codigo}`, textX, posY);
  posY += lineSpacing;

  doc.text(`Fecha:`, textX, posY);
  doc.font('Helvetica').text(fechaActuacion, textX + 60, posY);
  posY += lineSpacing;

  doc.font('Helvetica-Bold').text(descripcionProducto, textX, posY, { width: boxWidth - 160 });
  posY += lineSpacing;

  doc.font('Helvetica').text(direccionEvento, textX, posY, { width: boxWidth - 160 });

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
