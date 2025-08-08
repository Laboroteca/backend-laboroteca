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

  // Imagen de fondo (usar imagen por defecto si no se especifica)
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-1.jpg';

  try {
    const response = await fetch(urlFondo);
    if (!response.ok) throw new Error(`Error ${response.status} al descargar la imagen`);

    const arrayBuffer = await response.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Convertir a PNG con sharp para que PDFKit la entienda
    const pngBuffer = await sharp(inputBuffer).png().toBuffer();

    // Insertar imagen convertida en el PDF
    doc.image(pngBuffer, 0, 0, { width: doc.page.width, height: doc.page.height });

    console.log(`✅ Imagen de fondo aplicada correctamente para ${codigo}`);
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // Generar código QR
  const qrData = `https://laboroteca.es/validar-entrada?codigo=${codigo}`;
  const qrImage = await QRCode.toBuffer(qrData);

  // Estilos
  const negro = '#000000';
  const startX = 200;
  let posY = 150;
  const lineSpacing = 30;

  // Texto sobre fondo
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

  // Código QR a la izquierda
  doc.image(qrImage, 50, 150, { width: 120 });

  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

module.exports = { generarEntradaPDF };
