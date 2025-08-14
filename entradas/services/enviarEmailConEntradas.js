// 📂 /entradas/services/enviarEmailConEntradas.js
const { enviarEmailPersonalizado } = require('../../services/email');

// --- Pie RGPD (mismo separador y estilos que usas en el resto) ---
const PIE_HTML = `
  <hr style="margin-top: 40px; margin-bottom: 10px;" />
  <div style="font-size: 12px; color: #777; line-height: 1.5;">
    En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
    Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
    Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente.
  </div>
`.trim();

const PIE_TEXT = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: laboroteca@gmail.com
También puede reclamar ante la autoridad de control si lo considera necesario.
`.trim();

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

  // ✅ HTML con enlace en texto plano
  const htmlPrincipal = `
    <p>Hola ${nombre},</p>
    <p>Gracias por tu compra. Te enviamos tus entradas para el siguiente evento:</p>
    <p><strong>${descripcionProducto}</strong></p>
    <p>Importe total: <strong>${importe.toFixed(2)} €</strong></p>
    <p>Cada entrada incluye un código QR único que se validará el día del evento. Puedes llevarlas en el móvil o impresas.</p>
    <p>
      Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:<br/>
      https://www.laboroteca.es/canjear-codigo-regalo/<br/>
      Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
      Solo se validará una entrada por cada asistente.
    </p>
    <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
  `;

  // ✅ Texto plano con enlace en texto simple
  const textPrincipal = `Hola ${nombre},

Gracias por tu compra. Te enviamos tus entradas para:

- ${descripcionProducto}
- Importe total: ${importe.toFixed(2)} €

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Laboroteca`;

  // ➕ Añadimos el pie RGPD solo si no está ya presente
  const html = htmlPrincipal.includes(PIE_HTML) ? htmlPrincipal : `${htmlPrincipal}\n${PIE_HTML}`;
  const text = textPrincipal.includes(PIE_TEXT) ? textPrincipal : `${textPrincipal}\n\n${PIE_TEXT}`;

  // 📎 Adjuntar entradas
  const attachments = entradas.map((entrada, i) => ({
    filename: `ENTRADA ${i + 1}.pdf`,
    fileblob: entrada.buffer.toString('base64'),
    mimetype: 'application/pdf'
  }));

  // 📎 Adjuntar factura si hay
  if (facturaAdjunta && Buffer.isBuffer(facturaAdjunta)) {
    attachments.push({
      filename: 'Factura Laboroteca.pdf',
      fileblob: facturaAdjunta.toString('base64'),
      mimetype: 'application/pdf'
    });
  }

  // 📤 Enviar email
  await enviarEmailPersonalizado({
    to: email,
    subject,
    html,
    text,
    attachments
  });

  console.log(`📧 Email con ${entradas.length} entradas enviado a ${email}`);
}

module.exports = { enviarEmailConEntradas };
