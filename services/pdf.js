const PDFDocument = require('pdfkit');

/**
 * Genera una factura PDF en buffer a partir de los datos del cliente.
 * Campos esperados en `datos` (opcionales salvo importe/email):
 *  - nombre, apellidos, dni, email, direccion, cp, ciudad, provincia
 *  - importe (TOTAL con IVA), producto | nombreProducto | descripcionProducto
 *  - numeroFactura | numFactura | idfactura
 *  - fecha | fechaFactura (string legible, ej. "01/02/2025")
 */
function generarFacturaPDF(datos = {}) {
  return new Promise((resolve, reject) => {
    try {
      // ───────── Helpers (sin logs ni efectos externos) ─────────
      const safe = (v = '') => String(v ?? '').replace(/\s+/g, ' ').trim();
      const num = (v) => {
        const n = Number(String(v ?? '0').replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
      };
      const trunc2 = (x) => Math.floor(Number(x) * 100) / 100; // truncado (no redondeo)
      const euros = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;

      const total = num(datos.importe);
      const base = trunc2(total / 1.21);        // base imponible (21% IVA)
      const iva = trunc2(total - base);         // cuota IVA (truncada)
      const fecha =
        safe(datos.fecha || datos.fechaFactura) ||
        new Date().toLocaleDateString('es-ES');
      const numero =
        safe(datos.numeroFactura || datos.numFactura || datos.idfactura || '');
      const producto = safe(
        datos.producto || datos.nombreProducto || datos.descripcionProducto || 'Producto Laboroteca'
      );

      const cliente = {
        nombre: safe(datos.nombre),
        apellidos: safe(datos.apellidos),
        dni: safe(datos.dni),
        email: safe(datos.email),
        direccion: safe(datos.direccion),
        cp: safe(datos.cp),
        ciudad: safe(datos.ciudad),
        provincia: safe(datos.provincia),
      };

      // ───────── PDF ─────────
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];
      doc.on('data', (ch) => buffers.push(ch));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // Encabezado
      doc.font('Helvetica-Bold').fontSize(20).text('Factura', { align: 'center', underline: true }).moveDown(1);

      // Nº y fecha (arriba a la derecha)
      doc.font('Helvetica').fontSize(10);
      if (numero) doc.text(`Nº: ${numero}`, { align: 'right' });
      doc.text(`Fecha: ${fecha}`, { align: 'right' }).moveDown(1);

      // Datos emisor (fijos, si quieres cambiarlos hazlo aquí)
      doc.fontSize(11).text('Emisor:', { continued: false }).moveDown(0.2);
      doc.fontSize(10)
        .text('Ignacio Solsona Fernández-Pedrera')
        .text('DNI: 20481042W')
        .text('C/ Enmedio 22, 3.º E')
        .text('12001 Castellón de la Plana (España)')
        .moveDown(0.8);

      // Datos del cliente
      const yStartCliente = doc.y;
      doc.fontSize(11).text('Cliente:', { continued: false }).moveDown(0.2);
      doc.fontSize(10)
        .text(`Nombre: ${cliente.nombre} ${cliente.apellidos}`)
        .text(`DNI: ${cliente.dni}`)
        .text(`Email: ${cliente.email}`)
        .text(
          `Dirección: ${cliente.direccion}${
            cliente.cp ? ', ' + cliente.cp : ''
          } ${cliente.ciudad}${cliente.provincia ? ' (' + cliente.provincia + ')' : ''}`
        )
        .moveDown(1);

      // Separador
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke().moveDown(0.8);

      // Concepto
      doc.font('Helvetica-Bold').fontSize(12).text('Concepto').moveDown(0.3);
      doc.font('Helvetica').fontSize(11).text(producto).moveDown(1);

      // Mini tabla importes (alineada a la derecha)
      const rightX = doc.page.width - doc.page.margins.right;
      const labelX = rightX - 180; // ancho aproximado etiqueta→importe
      const lineY1 = doc.y;

      doc.fontSize(11);
      doc.text('Base imponible', labelX, lineY1, { width: 140, continued: true });
      doc.text(euros(base), { align: 'right' });

      const lineY2 = doc.y;
      doc.text('IVA (21%)', labelX, lineY2, { width: 140, continued: true });
      doc.text(euros(iva), { align: 'right' });

      doc.moveTo(labelX, doc.y + 5).lineTo(rightX, doc.y + 5).stroke();

      doc.font('Helvetica-Bold');
      const lineY3 = doc.y + 10;
      doc.text('Total', labelX, lineY3, { width: 140, continued: true });
      doc.text(euros(total), { align: 'right' });
      doc.font('Helvetica').moveDown(2);

      // Nota legal breve
      doc.fontSize(9).fillColor('gray')
        .text(
          'Los importes incluyen IVA según régimen general. Esta factura ha sido emitida electrónicamente.',
          { align: 'left' }
        )
        .moveDown(0.5)
        .text('Gracias por su confianza.', { align: 'left' })
        .fillColor('black');

      // Pie
      doc.moveDown(2);
      doc.fontSize(10).fillColor('gray')
        .text('Laboroteca – www.laboroteca.es', { align: 'center' })
        .fillColor('black');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarFacturaPDF };
