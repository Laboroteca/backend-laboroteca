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

  // ✅ Fondo arriba, con proporciones
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  let imagenHeight = 400; // Altura reservada para la imagen

  try {
    const response = await fetch(urlFondo);
    const inputBuffer = Buffer.from(await response.arrayBuffer());
    const pngBuffer = await sharp(inputBuffer).resize({ height: imagenHeight }).png().toBuffer();

    doc.image(pngBuffer, 0, 0, { width: doc.page.width, height: imagenHeight });
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // ✅ QR DENTRO DE LA IMAGEN
  const qrSize = 150;
  const qrX = 50;
  const qrY = 50;
  const qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`);

  // Fondo blanco detrás del QR
  doc.fillColor('white').rect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20).fill();
  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // ✅ Código debajo del QR, también sobre fondo blanco
  const codigoY = qrY + qrSize + 15;
  doc.fillColor('white').rect(qrX - 10, codigoY - 5, 200, 25).fill();
  doc.fillColor('black').fontSize(14).font('Helvetica-Bold').text(`Código: ${codigo}`, qrX, codigoY);

  // ✅ TEXTOS FUERA DE LA IMAGEN
  let textY = imagenHeight + 50;
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
