require('dotenv').config();
console.log('📦 WEBHOOK CARGADO');

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const { guardarEnGoogleSheets } = require('../services/googleSheets');
const { crearFacturaEnFacturaCity } = require('../services/facturaCity');
const { enviarFacturaPorEmail } = require('../services/email');
const { subirFactura } = require('../services/gcs');
// const { activarMembresiaEnMemberPress } = require('../services/memberpress'); // ← Recordatorio: activar cuando pasemos a Live
const axios = require('axios');

module.exports = async function (req, res) {
  console.log('🔥 LLEGÓ AL WEBHOOK');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('🎯 Webhook verificado correctamente');
  } catch (err) {
    console.error('❌ Firma inválida del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log('✅ Evento recibido: checkout.session.completed');
    console.log('📧 Email:', session.customer_details?.email);
    console.log('📦 Metadata:', session.metadata);
    console.log('💰 Monto total:', session.amount_total);

    try {
      await procesarCompra(session);
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('❌ Error procesando compra:', err);
      return res.status(500).json({ error: 'Error procesando la compra' });
    }
  } else {
    console.log(`ℹ️ Evento no manejado: ${event.type}`);
    return res.status(200).json({ received: true });
  }
};

async function procesarCompra(session) {
  const m = session.metadata || {};
  const email = session.customer_details?.email || m.email || '';
  const name = session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`.trim();
  const amountTotal = session.amount_total || 0;

  const datosCliente = {
    nombre: m.nombre || name || '',
    apellidos: m.apellidos || '',
    dni: m.dni || '',
    importe: parseFloat((amountTotal / 100).toFixed(2)),
    email,
    direccion: m.direccion || '',
    ciudad: m.ciudad || '',
    provincia: m.provincia || '',
    cp: m.cp || '',
    producto: m.nombreProducto || 'producto_desconocido',
    tipoProducto: m.tipoProducto || null
  };

  console.log('🧾 Datos del cliente a procesar:\n', JSON.stringify(datosCliente, null, 2));

  try {
    console.log('📄 → Guardando en Google Sheets...');
    await guardarEnGoogleSheets(datosCliente);
    console.log('✅ Guardado en Sheets');

    console.log('🧾 → Generando factura...');
    const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
    console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);

    const nombreArchivo = `facturas/${datosCliente.email}/${Date.now()}-${datosCliente.producto}.pdf`;
    console.log('☁️ → Subiendo a GCS:', nombreArchivo);
    await subirFactura(nombreArchivo, pdfBuffer, {
      email: datosCliente.email,
      nombreProducto: datosCliente.producto,
      tipoProducto: datosCliente.tipoProducto,
      importe: datosCliente.importe
    });
    console.log('✅ Subido a GCS');

    console.log('📧 → Enviando email con la factura...');
    try {
      await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      console.log('✅ Email enviado');
    } catch (emailError) {
      console.error('❌ Error enviando email:');
      console.error(emailError);
    }

    // 🚫❌ ACTIVACIÓN DE MEMBRESÍA DESACTIVADA TEMPORALMENTE ❌🚫
    // 🧠 RECORDATORIO CENUTRIO: ACTÍVALO EN PRODUCCIÓN (LIVE MODE STRIPE)
    /*
    console.log('🔐 → Activando acceso en MemberPress...');
    await activarMembresiaEnMemberPress(email, datosCliente.producto);
    console.log('✅ Acceso activado');
    */

  } catch (error) {
    console.error('❌ Error en procesarCompra:', error);
    throw error;
  }
}

// 🔔 Cuando se active, vuelve a incluir esta función y su require arriba.
// async function activarMembresiaEnMemberPress(email, productoSlug) { ... }