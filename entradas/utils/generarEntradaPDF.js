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

  // Imagen de fondo con proporción
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  try {
    const response = await fetch(urlFondo);
    if (!response.ok) throw new Error(`Error ${response.status} al descargar imagen`);

    const arrayBuffer = await response.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);
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

  // QR a la izquierda
  const qrX = 50;
  const qrY = 100;
  const qrSize = 200;
  const qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`);
  doc.image(qrBuffer, qrX, qrY, { width: qrSize });

  // "Código" arriba a la derecha del QR
  const textX = qrX + qrSize + 20;
  let posY = qrY;
  const lineHeight = 40;
  const boxPadding = 10;
  const boxWidth = 300;

  const drawTextBox = (texto, fontSize = 18, bold = false) => {
    const boxHeight = lineHeight;
    doc.fillColor('white')
      .rect(textX, posY, boxWidth, boxHeight)
      .fill();
    doc.fillColor('black')
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .text(texto, textX + boxPadding, posY + 10, {
        width: boxWidth - 2 * boxPadding,
        align: 'left'
      });
    posY += boxHeight + 10;
  };

  drawTextBox(`Código: ${codigo}`, 18, true);

  // Bajar "Entrada para" y "Fecha"
  posY = qrY + qrSize - 20;
  drawTextBox(`Entrada para:`, 18, true);
  drawTextBox(fechaActuacion, 18);

  // Campos largos, A LA IZQUIERDA, MISMO X que el QR
  const bottomX = qrX;
  let bottomY = qrY + qrSize + 60;
  const bottomWidth = 500;

  const drawBottomBox = (texto, fontSize = 18, bold = false) => {
    const boxHeight = lineHeight;
    doc.fillColor('white')
      .rect(bottomX, bottomY, bottomWidth, boxHeight)
      .fill();
    doc.fillColor('black')
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .text(texto, bottomX + boxPadding, bottomY + 10, {
        width: bottomWidth - 2 * boxPadding,
        align: 'left'
      });
    bottomY += boxHeight + 10;
  };

  drawBottomBox(descripcionProducto, 18, true);
  drawBottomBox(direccionEvento, 16);

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
