const { enviarEmailPersonalizado } = require('../../services/email');


/**
 * Envía un email al comprador con las entradas adjuntas y la factura (si la hay).
 * 
 * @param {Object} opciones
 * @param {string} opciones.email - Email del comprador
 * @param {string} opciones.nombre - Nombre del comprador
 * @param {Array} opciones.entradas - Array de objetos { buffer }
 * @param {Buffer|null} opciones.facturaAdjunta - Buffer del PDF de la factura (opcional)
 * @param {string} opciones.descripcionProducto - Nombre del evento
 * @param {number} opciones.importe - Precio total
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
    throw new Error('No hay entradas que enviar');
  }

  const subject = `🎟️ Tus entradas para ${descripcionProducto}`;
  const html = `
    <p>Hola ${nombre},</p>
    <p>Gracias por tu compra. Adjuntamos tus entradas para el evento:</p>
    <p><strong>${descripcionProducto}</strong></p>
    <p>Importe total: <strong>${importe.toFixed(2)} €</strong></p>
    <p>Cada entrada incluye un código QR único que se validará el día del evento. Puedes llevarla en el móvil o impresa.</p>
    <p>Si tienes cualquier duda, puedes responder a este email o escribir a <a href="mailto:info@laboroteca.es">info@laboroteca.es</a>.</p>
    <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
  `;

  const text = `Hola ${nombre},

Gracias por tu compra. Adjuntamos tus entradas para el evento:

- ${descripcionProducto}
- Importe total: ${importe.toFixed(2)} €

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarla en el móvil o impresa.

Si tienes cualquier duda, escríbenos a info@laboroteca.es

Un saludo,
Ignacio Solsona
Laboroteca`;

  const attachments = entradas.map((entrada, index) => ({
    filename: `ENTRADA ${index + 1}.pdf`,
    fileblob: entrada.buffer.toString('base64'),
    mimetype: 'application/pdf'
  }));

  if (facturaAdjunta && Buffer.isBuffer(facturaAdjunta)) {
    attachments.push({
      filename: 'Factura Laboroteca.pdf',
      fileblob: facturaAdjunta.toString('base64'),
      mimetype: 'application/pdf'
    });
  }

  await enviarEmailPersonalizado({
    to: email,
    subject,
    html,
    text,
    pdfBuffer: null, // usamos attachments
    enviarACopy: true, // copia a laboroteca@gmail.com
    attachments
  });

  console.log(`📧 Email con ${entradas.length} entradas enviado a ${email}`);
}

module.exports = { enviarEmailConEntradas };
