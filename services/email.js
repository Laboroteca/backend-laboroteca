require('dotenv').config(); // 🔐 Asegura que siempre se cargue el .env

const nodemailer = require('nodemailer');

async function enviarFacturaPorEmail(datos, pdfBuffer) {
  try {
    console.log('📨 FUNCIÓN enviarFacturaPorEmail LLAMADA');
    console.log('📎 Tamaño del PDF recibido:', pdfBuffer?.length || 0);
    console.log('🧾 Datos del cliente recibidos:', JSON.stringify(datos, null, 2));

    if (!pdfBuffer) {
      console.warn('⚠️ No se recibió ningún buffer de PDF');
      throw new Error('PDF nulo o indefinido');
    }

    if (pdfBuffer.length < 5000) {
      console.warn('⚠️ PDF demasiado pequeño. Posible error. Email no enviado.');
      throw new Error('PDF demasiado pequeño');
    }

    // ✅ Protege el campo importe
    const importeTexto = datos.importe
      ? `${Number(datos.importe).toFixed(2)} €`
      : 'importe no disponible';

    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: parseInt(process.env.MAIL_PORT),
      secure: true,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
      },
      logger: true,
      debug: true
    });

    const html = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Hola ${datos.nombre},</p>
        <p>Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p><strong>${datos.producto}</strong></p>
        <p>Importe: <strong>${importeTexto}</strong></p>

        <p>Puedes acceder a tu contenido desde <a href="https://laboroteca.es/mi-cuenta">www.laboroteca.es/mi-cuenta</a></p>

        <p>Un afectuoso saludo,<br>Ignacio Solsona</p>

        <hr style="margin-top: 40px; margin-bottom: 10px;" />
        <div style="font-size: 12px; color: #777; line-height: 1.5;">
          En cumplimiento de lo previsto por el Reglamento (UE) 2016/679, del Parlamento Europeo y del Consejo, de 27 de abril de 2016, relativo a la protección de las personas físicas en lo que respecta al tratamiento de datos personales (Reglamento Europeo de Protección de Datos), le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
          Su dirección de correo electrónico se utiliza con la finalidad de prestarle servicios jurídicos y la base jurídica para tal utilización es el consentimiento otorgado por usted para el uso de sus datos con esta finalidad. Usted tiene derecho a retirar este consentimiento en cualquier momento.<br /><br />
          De acuerdo con el artículo 13 del Reglamento Europeo de Protección de Datos, le informamos que usted tiene derecho a ejercer en relación a sus datos personales los derechos de acceso, rectificación, supresión, portabilidad, limitación del tratamiento, así como a oponerse a dicho tratamiento o al uso de sus datos para la elaboración de decisiones individuales automatizadas incluida la elaboración de perfiles, contactando con la siguiente dirección de correo electrónico: ignacio.solsona@icacs.com. Igualmente le informamos que usted tiene derecho a presentar una reclamación ante la autoridad de control competente en caso de que considere que se ha vulnerado algún derecho en relación a la protección de sus datos personales.
        </div>
      </div>
    `;

    const text = `
Hola ${datos.nombre},

Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:
- ${datos.producto}
- Importe: ${importeTexto}

Puedes acceder a tu contenido desde: https://laboroteca.es/mi-cuenta

Un afectuoso saludo,
Ignacio Solsona

------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Su dirección se utiliza para prestarle servicios jurídicos. Puede retirar su consentimiento en cualquier momento y ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación del tratamiento y oposición contactando con: ignacio.solsona@icacs.com
También puede presentar reclamación ante la autoridad de control competente si considera vulnerados sus derechos.
`;

    const mailOptions = {
      from: `"Laboroteca" <${process.env.MAIL_USER}>`,
      to: datos.email,
      subject: 'Confirmación de tu compra en Laboroteca',
      text,
      html,
      attachments: [
        {
          filename: `Factura - ${datos.producto}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    };

    console.log('✅ Email se enviará desde:', process.env.MAIL_USER);
    console.log('📤 Enviando a:', datos.email);

    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email enviado con éxito ✅');
    console.log('📨 Message ID:', info.messageId);
    console.log('📫 Respuesta completa:', info);
    return 'OK';
  } catch (error) {
    console.error('❌ Error al enviar el email:');
    console.error(error);
    throw error;
  }
}

module.exports = { enviarFacturaPorEmail };
