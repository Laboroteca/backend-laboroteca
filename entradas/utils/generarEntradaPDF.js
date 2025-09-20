const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// Dedupe simple de alertas en proceso
const __once = new Set();
function alertOnce(key, payload) {
  if (__once.has(key)) return;
  __once.add(key);
  try { alertAdmin(payload); } catch (_) {}
}

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
  // No comprimir el PDF para preservar calidad de imágenes
  const doc = new PDFDocument({ size: 'A4', margin: 0, compress: false });
  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  // ✅ Imagen de fondo proporcional
  const urlFondo = imagenFondo?.startsWith('http')
    ? imagenFondo
    : 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-qr-scaled.jpg';

  let imagenHeight = 0;
   try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(urlFondo, { signal: controller.signal });
    clearTimeout(to);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const inputBuffer = Buffer.from(await response.arrayBuffer());

    // Intentamos embeber el buffer original (sin recomprimir).
    // Si es un formato no soportado por PDFKit (p.ej. WebP), convertimos a PNG **sin** redimensionar.
    let embedBuffer = inputBuffer;
    try {
      const meta = await sharp(inputBuffer).metadata();
      const fmt = (meta.format || '').toLowerCase();
      if (fmt === 'webp' || fmt === 'gif' || fmt === 'tiff') {
        embedBuffer = await sharp(inputBuffer).png().toBuffer(); // conversión sin resize (sin pérdida adicional respecto a PNG)
      }
      // Altura proporcional a página al usar fit
      imagenHeight = doc.page.height;
      doc.image(embedBuffer, 0, 0, { fit: [doc.page.width, doc.page.height] });
    } catch (e) {
      // Fallback directo (si falla sharp, intentamos igualmente embeber tal cual)
      imagenHeight = doc.page.height;
      doc.image(embedBuffer, 0, 0, { fit: [doc.page.width, doc.page.height] });
    }
  } catch (err) {
    console.warn(`⚠️ No se pudo cargar imagen de fondo para ${codigo}:`, err.message);
  }

  // ✅ QR
  const qrSize = 150;
  const qrX = 50;
  const qrY = 50;
  const qrPadding = 10;
  let qrBuffer;
  try {
    // QR en alta resolución para máxima nitidez (re-escalado hacia abajo en el PDF)
    qrBuffer = await QRCode.toBuffer(`https://laboroteca.es/validar-entrada?codigo=${codigo}`, {
      errorCorrectionLevel: 'H',
      type: 'png',
      width: 600,
      margin: 1
    });
  } catch (err) {
    // 🚨 Esto sí requiere intervención: sin QR la entrada no es válida
    alertOnce(`entradas.pdf.qr.${codigo || 'sin_codigo'}`, {
      area: 'entradas.pdf.qr_error',
      err,
      meta: { codigo, nombreActuacion, descripcionProducto }
    });
    throw err;
  }

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
  // Al ocupar el fondo toda la página con fit, colocamos el texto con margen superior estable
  let textY = Math.min(imagenHeight, doc.page.height) + 40;
  if (textY < 200) textY = 200; // salvaguarda para layouts con fondos pequeños
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

// ✅ Texto promocional con interlineado 1.2
const promoX = 50;
const promoWidth = doc.page.width - 100;
const lineGap = 4; // Interlineado más normal, similar a 1.2 en Word

const intro1 = 'Si quieres acceder a contenido exclusivo sobre Derechos Laborales y Seguridad Social, puedes hacerte socio del ';
const clubTexto = 'Club Laboroteca';
const intro2 = ', por una cuota de 9,99 € / mes y sin compromiso de permanencia.';

doc.font('Helvetica-Bold').fontSize(12).fillColor('black')
  .text(intro1, promoX, textY, { width: promoWidth, continued: true, lineGap });

doc.font('Helvetica-Bold').fillColor('black')
  .text(clubTexto, { continued: true, lineGap });

doc.text(intro2, { lineGap });
textY = doc.y + 10;


// ✅ Tabla 2x2 con punto normal (•)
const tablaItems = [
  ['•', 'Vídeos exclusivos'],
  ['•', 'Podcast “Te lo has currado”'],
  ['•', 'Artículos exclusivos'],
  ['•', 'Noticias y sentencias novedosas']
];

const colWidth = (doc.page.width - 100) / 2;
const rowHeight = 24;

doc.font('Helvetica');
for (let i = 0; i < tablaItems.length; i += 2) {
  const rowY = textY + (i / 2) * rowHeight;
  const [icon1, texto1] = tablaItems[i];
  const [icon2, texto2] = tablaItems[i + 1];

  doc.text(`${icon1} ${texto1}`, promoX, rowY, { width: colWidth });
  doc.text(`${icon2} ${texto2}`, promoX + colWidth, rowY, { width: colWidth });
}


  // ✅ Imagen promocional entradas
  const clubImgURL = 'https://www.laboroteca.es/wp-content/uploads/2025/08/CLUB-LABOROTECA-scaled.jpg';

  try {
    const controller2 = new AbortController();
    const to2 = setTimeout(() => controller2.abort(), 10000);
    const clubResponse = await fetch(clubImgURL, { signal: controller2.signal });
    clearTimeout(to2);
    if (!clubResponse.ok) throw new Error(`Error ${clubResponse.status}`);
    const clubBuffer = Buffer.from(await clubResponse.arrayBuffer());

    const imgX = 50;
    const imgY = textY + 70;
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
