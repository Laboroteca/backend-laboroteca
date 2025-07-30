const { enviarEmailPersonalizado } = require('../../services/email');

/**
 * Envía un email al comprador con las entradas y factura (si procede)
 * 
 * @param {Object} opciones
 * @param {string} opciones.email - Email del comprador
 * @param {string} opciones.nombre - Nombre del comprador
 * @param {Array<{ buffer: Buffer }>} opciones.entradas - Entradas en PDF
 * @param {Buffer|null} opciones.facturaAdjunta - Factura en PDF (opcional)
 * @param {string} opciones.descripcionProducto - Nombre del evento
 * @param {number} opciones.importe - Importe total en €
 */
async function enviarEmailConEntradas({
  email,
  nombre,
  entradas,
  facturaAdjunta = null,
  descripcionProducto,
  importe
}) {
  if (!Array.isArray(entradas) || entradas.length === 0) {
    throw new Error('No hay entradas que enviar.');
  }

  const subject = `🎟️ Tus entradas para ${descripcionProducto}`;
  const html = `
    <p>Hola ${nombre},</p>
    <p>Gracias por tu compra. Te enviamos tus entradas para el siguiente evento:</p>
    <p><strong>${descripcionProducto}</strong></p>
    <p>Importe total: <strong>${importe.toFixed(2)} €</strong></p>
    <p>Cada entrada incluye un código QR único que se validará el día del evento. Puedes llevarlas en el móvil o impresas.</p>
    <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
  `;

  const text = `Hola ${nombre},

Gracias por tu compra. Te enviamos tus entradas para:

- ${descripcionProducto}
- Importe total: ${importe.toFixed(2)} €

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Un saludo,
Ignacio Solsona
Laboroteca`;

  // Adjuntar entradas
  const attachments = entradas.map((entrada, i) => ({
    filename: `ENTRADA ${i + 1}.pdf`,
    fileblob: entrada.buffer.toString('base64'),
    mimetype: 'application/pdf'
  }));

  // Adjuntar factura si hay
  if (facturaAdjunta && Buffer.isBuffer(facturaAdjunta)) {
    attachments.push({
      filename: 'Factura Laboroteca.pdf',
      fileblob: facturaAdjunta.toString('base64'),
      mimetype: 'application/pdf'
    });
  }

  // Enviar email
  await enviarEmailPersonalizado({
    to: email,
    subject,
    html,
    text,
    pdfBuffer: null,
    attachments
  });

  console.log(`📧 Email con ${entradas.length} entradas enviado a ${email}`);
}

module.exports = { enviarEmailConEntradas };
