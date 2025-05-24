const PDFDocument = require('pdfkit');

/**
 * Genera una factura PDF en buffer a partir de los datos del cliente
 * @param {Object} datos - Datos del cliente y la factura
 * @returns {Promise<Buffer>} - Buffer del PDF generado
 */
function generarFacturaPDF(datos) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });

      // Encabezado
      doc
        .fontSize(20)
        .text('Factura', { align: 'center', underline: true })
        .moveDown(1.5);

      // Datos del cliente
      doc
        .fontSize(12)
        .text(`Nombre: ${datos.nombre || ''} ${datos.apellidos || ''}`)
        .text(`DNI: ${datos.dni || ''}`)
        .text(`Email: ${datos.email || ''}`)
        .text(`Dirección: ${datos.direccion || ''}, ${datos.cp || ''} ${datos.ciudad || ''} (${datos.provincia || ''})`)
        .moveDown();

      // Detalles de la factura
      doc
        .text(`Producto adquirido: ${datos.producto || ''}`)
        .text(`Importe total: ${Number(datos.importe || 0).toFixed(2)} €`, { align: 'right' })
        .moveDown();

      // Pie
      doc
        .fontSize(10)
        .fillColor('gray')
        .text('Laboroteca – www.laboroteca.es', { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarFacturaPDF };
