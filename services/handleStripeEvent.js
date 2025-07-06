const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'de cara a la jubilacion': 7994,
  'de-cara-a-la-jubilacion': 7994 // Por si acaso algún slug llega así
};

async function handleStripeEvent(event) {
  const type = event.type;

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;
    if (session.payment_status !== 'paid') return { ignored: true };

    // Idempotencia
    const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
    const procesado = await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (doc.exists) return true;
      transaction.set(docRef, {
        sessionId,
        email: '',
        producto: '',
        fecha: new Date().toISOString(),
        procesando: true,
        error: false,
        facturaGenerada: false
      });
      return false;
    });
    if (procesado) return { duplicate: true };

    const m = session.metadata || {};
    const email = m.email_autorelleno || m.email || session.customer_details?.email || '';
    const name = session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`.trim();
    const amountTotal = session.amount_total || 0;

    // --- Detección fiable de producto ---
    const rawNombreProducto = (m.nombreProducto || '').toLowerCase().trim();
    let productoSlug = rawNombreProducto;
    if (productoSlug === 'el club laboroteca') productoSlug = 'el club laboroteca';
    if (productoSlug === 'de cara a la jubilacion' || productoSlug === 'de-cara-a-la-jubilacion') productoSlug = 'de cara a la jubilacion';
    const memberpressId = MEMBERPRESS_IDS[productoSlug];

    const datosCliente = {
      nombre: m.nombre || name,
      apellidos: m.apellidos || '',
      dni: m.dni || '',
      email,
      direccion: m.direccion || '',
      ciudad: m.ciudad || '',
      provincia: m.provincia || '',
      cp: m.cp || '',
      importe: parseFloat((amountTotal / 100).toFixed(2)),
      tipoProducto: m.tipoProducto || 'Otro',
      nombreProducto: productoSlug,
      descripcionProducto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido',
      producto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido'
    };

    let errorProcesando = false;

    try {
      await guardarEnGoogleSheets(datosCliente);
      const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);

      const nombreArchivo = `facturas/${email}/${Date.now()}-${datosCliente.producto}.pdf`;
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto: datosCliente.producto,
        tipoProducto: datosCliente.tipoProducto,
        importe: datosCliente.importe
      });

      try {
        await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      } catch (err) {
        console.error('❌ Error enviando email con factura:', err?.message);
      }

      // 🔥 ACTIVACIÓN EN MEMBERPRESS SOLO LA CORRECTA:
      if (memberpressId === 10663) {
        // Club Laboroteca → SÓLO activar Club
        await syncMemberpressClub({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
        await activarMembresiaClub(email);
      }
      if (memberpressId === 7994) {
        // Libro vitalicio → SÓLO activar Libro
        await syncMemberpressLibro({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
      }

      // Lógica de cupones igual:
      if (m.codigoDescuento) {
        try {
          const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
          const cupones = JSON.parse(raw);
          const index = cupones.findIndex(c => c.codigo === m.codigoDescuento && !c.usado);
          if (index !== -1) {
            cupones[index].usado = true;
            await fs.writeFile(RUTA_CUPONES, JSON.stringify(cupones, null, 2));
          }
        } catch (err) {
          console.error('❌ Error marcando cupón como usado:', err?.message);
        }
      }
    } catch (error) {
      errorProcesando = true;
      console.error('❌ Error en flujo checkout.session.completed:', error?.message);
      await docRef.update({
        error: true,
        errorMsg: error?.message || error
      });
      throw error;
    } finally {
      await docRef.update({
        email,
        producto: datosCliente.producto,
        fecha: new Date().toISOString(),
        procesando: false,
        facturaGenerada: !errorProcesando,
        error: !!errorProcesando
      });
    }

    return { success: true };
  }

  // El resto igual...

  return { ignored: true };
}

module.exports = handleStripeEvent;
