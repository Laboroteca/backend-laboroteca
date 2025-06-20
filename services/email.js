require('dotenv').config(); // 🔐 Carga segura de variables
const fetch = require('node-fetch');

async function enviarFacturaPorEmail(datos, pdfBuffer) {
  try {
    console.log('📨 FUNCIÓN enviarFacturaPorEmail LLAMADA');
    console.log('📎 Tamaño del PDF recibido:', pdfBuffer?.length || 0);
    console.log('🧾 Datos del cliente recibidos:', JSON.stringify(datos, null, 2));

    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
      console.warn('⚠️ El PDF recibido no es válido');
      throw new Error('El PDF no es un buffer válido');
    }

    if (pdfBuffer.length < 5000) {
      console.warn('⚠️ PDF demasiado pequeño. Posible error. Email no enviado.');
      throw new Error('El PDF es demasiado pequeño para ser válido');
    }

    const importeTexto = datos.importe
      ? `${Number(datos.importe).toFixed(2)} €`
      : 'importe no disponible';

    const html_body = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Hola ${datos.nombre},</p>
        <p>Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p><strong>${datos.producto}</strong></p>
        <p>Importe: <strong>${importeTexto}</strong></p>

        <p>Puedes acceder a tu contenido desde <a href="https://laboroteca.es/mi-cuenta">www.laboroteca.es/mi-cuenta</a></p>

        <p>Un afectuoso saludo,<br>Ignacio Solsona</p>

        <hr style="margin-top: 40px; margin-bottom: 10px;" />
        <div style="font-size: 12px; color: #777; line-height: 1.5;">
          En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
          Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
          Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: ignacio.solsona@icacs.com. También puede presentar una reclamación ante la autoridad de control competente.
        </div>
      </div>
    `;

    const text_body = `
Hola ${datos.nombre},

Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:
- ${datos.producto}
- Importe: ${importeTexto}

Puedes acceder a tu contenido desde: https://laboroteca.es/mi-cuenta

Un afectuoso saludo,
Ignacio Solsona

------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: ignacio.solsona@icacs.com
También puede reclamar ante la autoridad de control si lo considera necesario.
`;

    const response = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.SMTP2GO_API_KEY,
        to: [datos.email],
        sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`, // ✅ Nombre forzado
        subject: 'Factura de tu compra en Laboroteca',
        html_body,
        text_body,
        attachments: [
          {
            filename: 'Factura Laboroteca.pdf',
            fileblob: pdfBuffer.toString('base64'),
            mimetype: 'application/pdf'
          }
        ]
      })
    });

    const resultado = await response.json();

    if (!resultado.success && resultado.data?.succeeded !== 1) {
      console.error('❌ Error desde SMTP2GO:', JSON.stringify(resultado, null, 2));
      throw new Error('Error al enviar email con SMTP2GO');
    }

    console.log('✅ Email enviado con éxito vía SMTP2GO');
    return 'OK';
  } catch (error) {
    console.error('❌ Error al enviar el email:', error);
    throw error;
  }
}

module.exports = { enviarFacturaPorEmail };
