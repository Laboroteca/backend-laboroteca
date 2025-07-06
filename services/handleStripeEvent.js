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

function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-]+/g, ' ')
    .trim();
}

const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'de cara a la jubilacion': 7994
};

async function handleStripeEvent(event) {
  if (event.type !== 'checkout.session.completed') {
    return { ignored: true };
  }

  const session = event.data.object;
  const sessionId = session.id;
  if (session.payment_status !== 'paid') return { ignored: true };

  const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
  const yaProcesado = await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(docRef);
    if (doc.exists) return true;
    tx.set(docRef, {
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
  if (yaProcesado) return { duplicate: true };

  const m = session.metadata || {};
  console.log('🧐 Stripe metadata recibida:', m);

  const email = (
    (m.email_autorelleno && m.email_autorelleno.includes('@') && m.email_autorelleno) ||
    (m.email && m.email.includes('@') && m.email) ||
    (session.customer_details?.email && session.customer_details.email.includes('@') && session.customer_details.email) ||
    (session.customer_email && session.customer_email.includes('@') && session.customer_email)
  )?.toLowerCase().trim();

  if (!email) {
    console.error('❌ Email inválido en Stripe');
    await docRef.update({ error: true, errorMsg: 'Email inválido en Stripe' });
    return { error: 'Email inválido' };
  }

  const name = session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`.trim();
  const amountTotal = session.amount_total || 0;
  const rawNombreProducto = (m.nombreProducto || '').toLowerCase().trim();
  const productoSlug = normalizarProducto(rawNombreProducto);
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

  console.log('📦 Procesando producto:', datosCliente.nombreProducto, '-', datosCliente.importe, '€');

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
      console.error('❌ Error al enviar factura por email:', err?.message);
    }

    // 🎯 Activar CLUB (membresía recurrente)
    if (memberpressId === 10663) {
      console.log('🟦 Activando CLUB para', email);
      await syncMemberpressClub({
        email,
        accion: 'activar',
        membership_id: memberpressId,
        importe: datosCliente.importe
      });
      await activarMembresiaClub(email);
      console.log('✅ CLUB activado para', email);
    }

    // 📘 Activar LIBRO (transacción no recurrente)
    if (memberpressId === 7994) {
      console.log('🟨 Activando LIBRO para', email);
      const result = await syncMemberpressLibro({
        email,
        accion: 'activar',
        membership_id: memberpressId,
        importe: datosCliente.importe
      });
      console.log('📗 Resultado libro:', result);
    }

    // ❓ Producto no reconocido
    if (!memberpressId) {
      console.log('🟥 Producto desconocido:', productoSlug, rawNombreProducto);
    }

    // 🎟 Marcar cupón como usado (si procede)
    if (m.codigoDescuento) {
      try {
        const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
        const cupones = JSON.parse(raw);
        const i = cupones.findIndex(c => c.codigo === m.codigoDescuento && !c.usado);
        if (i !== -1) {
          cupones[i].usado = true;
          await fs.writeFile(RUTA_CUPONES, JSON.stringify(cupones, null, 2));
        }
      } catch (err) {
        console.error('❌ Error al marcar cupón como usado:', err?.message);
      }
    }

  } catch (err) {
    errorProcesando = true;
    console.error('❌ Error general en flujo Stripe:', err?.message);
    await docRef.update({ error: true, errorMsg: err?.message || err });
    throw err;
  } finally {
    await docRef.update({
      email,
      producto: datosCliente.producto,
      fecha: new Date().toISOString(),
      procesando: false,
      facturaGenerada: !errorProcesando,
      error: errorProcesando
    });
  }

  return { success: true };
}

module.exports = handleStripeEvent;
