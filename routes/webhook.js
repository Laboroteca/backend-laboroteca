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
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('❌ Error ejecutando procesarCompra():', err);
      return res.status(500).json({ error: 'Error procesando la compra' });
    }

  } else {
    console.log(`ℹ️ Evento no manejado: ${event.type}`);
    return res.status(200).json({ received: true });
  }
};

async function procesarCompra(session) {
  const metadata = session.metadata || {};
  const email = session.customer_details?.email || metadata.email || '';
  const name = session.customer_details?.name || `${metadata.nombre || ''} ${metadata.apellidos || ''}`.trim();
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

    console.log('📧 → Enviando email con factura...');
    await enviarFacturaPorEmail(datosCliente, pdfBuffer);
    console.log('✅ Email enviado con éxito');

    console.log('🔐 → Activando acceso en MemberPress...');
    await activarMembresiaEnMemberPress(email, datosCliente.producto);
    console.log('✅ Acceso concedido en MemberPress');

  } catch (error) {
    console.error('❌ Error en el flujo de procesarCompra:', error);
    throw error; // relanzamos para que lo capture el webhook
  }
}

async function activarMembresiaEnMemberPress(email, productoCrudo) {
  const usuario = 'ignacio';
  const claveApp = 'anKUsIXl31BsVZAaPSyepBRC';
  const auth = Buffer.from(`${usuario}:${claveApp}`).toString('base64');

  function normalizarProducto(nombre) {
    const mapa = {
      'De cara a la jubilación': 'libro_jubilacion',
      'Pack libros': 'libro_doble',
      'Curso IP Total': 'curso_ip_total'
    };
    return mapa[nombre] || null;
  }

  const productoNormalizado = normalizarProducto(productoCrudo);

  const PRODUCTO_MEMBERSHIP_MAP = {
    libro_jubilacion: 7994,
    libro_doble: 8420,
    curso_ip_total: 8650
  };

  const membershipId = PRODUCTO_MEMBERSHIP_MAP[productoNormalizado];
  if (!membershipId) {
    console.warn(`⚠️ Producto sin membresía asociada: ${productoCrudo} → ${productoNormalizado}`);
    return;
  }

  try {
    const buscarUsuario = await axios.get(
      `https://www.laboroteca.es/wp-json/wp/v2/users?search=${encodeURIComponent(email)}`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    const usuarios = buscarUsuario.data;
    const user = usuarios.find(u => u.email === email);

    if (!user) {
      console.warn('⚠️ Usuario no encontrado en WordPress con email exacto:', email);
      return;
    }

    const userId = user.id;

    await axios.post(
      'https://www.laboroteca.es/wp-json/mp/v1/memberships/add-member',
      {
        user_id: userId,
        membership_id: membershipId
      },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`🔓 Membresía ${membershipId} activada para usuario ${userId}`);

  } catch (err) {
    console.error('❌ Error al activar la membresía en MemberPress:', err.message);
  }
}