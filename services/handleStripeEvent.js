const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { desactivarMembresiaClub } = require('./desactivarMembresiaClub'); // Necesitarás crear esto (ver abajo)
const fs = require('fs').promises;
const path = require('path');
const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

async function handleStripeEvent(event) {
  const eventType = event.type;

  // 📥 COMPRA - FLUJO NORMAL
  if (eventType === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;

    if (session.payment_status !== 'paid') {
      console.warn(`⚠️ Sesión ${sessionId} con estado ${session.payment_status}. No se procesa.`);
      return { ignored: true };
    }

    const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
    if ((await docRef.get()).exists) {
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
      nombreProducto: m.nombreProducto || '',
      descripcionProducto: m.descripcionProducto || '',
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

    if (datosCliente.nombreProducto === 'El Club Laboroteca') {
      try {
        await activarMembresiaClub(email);
      } catch (err) {
        console.error('❌ Error al activar membresía del Club:', err);
      }
    }

    const codigoDescuento = m.codigoDescuento || '';
    if (codigoDescuento) {
      try {
        const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
        const cupones = JSON.parse(raw);
        const index = cupones.findIndex(c => c.codigo === codigoDescuento && !c.usado);

        if (index !== -1) {
          cupones[index].usado = true;
          await fs.writeFile(RUTA_CUPONES, JSON.stringify(cupones, null, 2));
          console.log(`🎟️ Cupón ${codigoDescuento} marcado como usado`);
        } else {
          console.warn(`⚠️ Cupón no encontrado o ya usado: ${codigoDescuento}`);
        }
      } catch (err) {
        console.error('❌ Error al actualizar cupones.json:', err);
      }
    }

    await docRef.set({
      sessionId,
      email,
      producto: datosCliente.producto,
      fecha: new Date().toISOString(),
      facturaGenerada: true
    });

    return { success: true };
  }

  // 🛑 BAJA - CANCELACIÓN DE SUSCRIPCIÓN CLUB
  if (eventType === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerEmail = subscription?.metadata?.email || subscription?.customer_email || '';

    console.log(`🛑 Suscripción cancelada para email: ${customerEmail}`);

    // Solo si es el Club Laboroteca
    if (subscription?.metadata?.nombreProducto === 'El Club Laboroteca') {
      try {
        await desactivarMembresiaClub(customerEmail);
        console.log(`✅ Membresía del Club desactivada para ${customerEmail}`);
      } catch (err) {
        console.error('❌ Error al desactivar membresía del Club:', err);
      }
    }

    // Puedes añadir aquí el envío de email de confirmación de baja si lo deseas

    // Opcional: guardar log en Firestore
    await firestore.collection('bajasProcesadas').add({
      email: customerEmail,
      fecha: new Date().toISOString(),
      subscriptionId: subscription.id
    });

    return { baja: true };
  }

  // Otros eventos no manejados
  console.log(`ℹ️ Evento no manejado: ${eventType}`);
  return { ignored: true };
}

module.exports = handleStripeEvent;
