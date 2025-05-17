const PDFDocument = require('pdfkit');

function generarFacturaPDF(datos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });

    doc
      .fontSize(16)
      .text('Factura', { align: 'center' })
      .moveDown();

    doc
      .fontSize(12)
      .text(`Nombre: ${datos.nombre} ${datos.apellidos}`)
      .text(`DNI: ${datos.dni}`)
      .text(`Email: ${datos.email}`)
      .text(`Dirección: ${datos.direccion}, ${datos.cp} ${datos.ciudad} (${datos.provincia})`)
      .moveDown();

    doc
      .text(`Producto: ${datos.producto}`)
      .text(`Importe: ${datos.importe.toFixed(2)} €`, { align: 'right' });

    doc
      .moveDown()
      .fontSize(10)
      .text('Laboroteca - www.laboroteca.es', { align: 'center' });

    doc.end();
  });
}

module.exports = { generarFacturaPDF };
