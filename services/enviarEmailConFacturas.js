// services/enviarEmailConFacturas.js
const nodemailer = require('nodemailer');

async function enviarEmailConFacturas({ email, nombre, facturas, count }) {
  // Configura tu transporter real (o reusa el que ya tengas)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    }
  });

  const attachments = facturas.map(f => ({
    filename: f.filename || 'factura.pdf',
    content: f.buffer
  }));

  const html = `
    <p>Hola ${nombre || ''},</p>
    <p>Adjuntamos ${count} factura(s) que has solicitado desde tu área de cliente.</p>
    <p>Gracias por confiar en Laboroteca.</p>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM || 'Laboroteca <no-reply@laboroteca.es>',
    to: email,
    subject: `Tus facturas (${count})`,
    html,
    attachments
  });
}

module.exports = { enviarEmailConFacturas };
