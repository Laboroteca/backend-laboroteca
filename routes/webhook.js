require('dotenv').config();
console.log('📦 WEBHOOK CARGADO');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const { guardarEnGoogleSheets } = require('../services/googleSheets');
const { crearFacturaEnFacturaCity } = require('../services/facturaCity');
const { enviarFacturaPorEmail } = require('../services/email');
const { subirFactura } = require('../services/gcs');
const axios = require('axios');

module.exports = async function (req, res) {
  console.log('🔥 LLEGÓ AL WEBHOOK');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('🎯 Webhook verificado correctamente');
  } catch (err) {
    console.error('❌ Firma no válida del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.status(200).json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Evento checkout.session.completed recibido');
    console.log('📦 Datos del session:', {
      email: session.customer_details?.email,
      metadata: session.metadata,
      amount_total: session.amount_total
    });

    try {
      await procesarCompra(session);
    } catch (err) {
      console.error('❌ Error ejecutando procesarCompra():', err);
    }
  }
};

async function procesarCompra(session) {
  const metadata = session.metadata || {};
  const email = session.customer_details?.email || '';
  const name = session.customer_details?.name || '';
  const amountTotal = session.amount_total || 0;

  const datosCliente = {
    nombre: metadata.nombre || name || '',
    apellidos: metadata.apellidos || '',
    dni: metadata.dni || '',
    importe: parseFloat((amountTotal / 100).toFixed(2)),
    email,
    direccion: metadata.direccion || '',
    ciudad: metadata.ciudad || '',
    provincia: metadata.provincia || '',
    cp: metadata.cp || '',
    producto: metadata.nombreProducto || 'Producto Laboroteca',
    tipoProducto: metadata.tipoProducto || null
  };

  console.log('🧾 Datos del cliente a procesar:');
  console.log(JSON.stringify(datosCliente, null, 2));

  try {
    console.log('📄 → Guardando en Google Sheets...');
    await guardarEnGoogleSheets(datosCliente);
    console.log('✅ Guardado en Google Sheets');

    console.log('🌍 → Enviando datos a Make...');
    await axios.post('https://hook.eu2.make.com/6hgbop0ra38k23w5xlutdg1oo2pu1dke', datosCliente);
    console.log('✅ Enviado correctamente a Make');

    console.log('🧾 → Generando factura en FacturaCity...');
    const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
    console.log(`✅ Factura generada. Tamaño PDF: ${pdfBuffer.length} bytes`);

    const nombreArchivo = `facturas/${datosCliente.email}/${Date.now()}-${datosCliente.producto}.pdf`;
    console.log(`☁️ → Subiendo a GCS como: ${nombreArchivo}`);
    await subirFactura(nombreArchivo, pdfBuffer, {
      email: datosCliente.email,
      nombreProducto: datosCliente.producto,
      tipoProducto: datosCliente.tipoProducto,
      importe: datosCliente.importe
    });
    console.log('✅ Factura subida a Google Cloud Storage');

    console.log('🔍 ENV SMTP:', {
      MAIL_HOST: process.env.MAIL_HOST,
      MAIL_PORT: process.env.MAIL_PORT,
      MAIL_USER: process.env.MAIL_USER,
      MAIL_PASS: process.env.MAIL_PASS ? '***' : undefined
    });

    console.log('📧 → Enviando email con factura...');
    await enviarFacturaPorEmail(datosCliente, pdfBuffer);
    console.log('✅ Email enviado con éxito');

  } catch (error) {
    console.error('❌ Error en el flujo de procesarCompra:', error);
  }
}
