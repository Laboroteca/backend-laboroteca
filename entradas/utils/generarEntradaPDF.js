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

  // Imagen de fondo (usar imagen por defecto si no se especifica)
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/entradas-laboroteca-scaled.jpg';

  try {
    const response = await fetch(urlFondo);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tempPath = path.join(__dirname, `../../temp_fondo_${codigo}.jpg`);

    await fs.writeFile(tempPath, buffer);
    doc.image(tempPath, 0, 0, { width: 595.28, height: 841.89 });
    await fs.unlink(tempPath);
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

  // Datos sobre fondo blanco
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
