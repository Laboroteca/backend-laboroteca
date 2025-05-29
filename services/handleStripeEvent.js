const admin = require('../firebase');
const firestore = admin.firestore();
const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
// const { activarMembresiaEnMemberPress } = require('./memberpress');

async function handleStripeEvent(event) {
  if (event.type !== 'checkout.session.completed') {
    console.log(`ℹ️ Evento no manejado: ${event.type}`);
    return { ignored: true };
  }

  const session = event.data.object;
  const sessionId = session.id;

  if (session.payment_status !== 'paid') {
    console.warn(`⚠️ Sesión ${sessionId} con estado ${session.payment_status}. No se procesa.`);
    return { ignored: true };
  }

  const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
  const alreadyProcessed = await docRef.get();

  if (alreadyProcessed.exists) {
    console.warn(`⚠️ La sesión ${sessionId} ya fue procesada. Ignorando duplicado.`);
    return { duplicate: true };
  }

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
    producto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido',
    tipoProducto: m.tipoProducto || 'Otro'
  };

  console.log('🧾 Procesando datos cliente:\n', JSON.stringify(datosCliente, null, 2));

  await guardarEnGoogleSheets(datosCliente);
  const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
  const nombreArchivo = `facturas/${email}/${Date.now()}-${datosCliente.producto}.pdf`;

  await subirFactura(nombreArchivo, pdfBuffer, {
    email,
    nombreProducto: datosCliente.producto,
    tipoProducto: datosCliente.tipoProducto,
    importe: datosCliente.importe
  });

  await enviarFacturaPorEmail(datosCliente, pdfBuffer);

  await docRef.set({
    sessionId,
    email,
    producto: datosCliente.producto,
    fecha: new Date().toISOString(),
    facturaGenerada: true
  });

  return { success: true };
}

module.exports = handleStripeEvent;
