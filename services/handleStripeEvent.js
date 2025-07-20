const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail, enviarAvisoImpago, enviarAvisoCancelacion } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const { registrarBajaClub } = require('./registrarBajaClub');
const desactivarMembresiaClub = require('./desactivarMembresiaClub');
const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '') // quita puntos
    .replace(/suscripcion mensual (a|al)? el? club laboroteca.*$/i, 'club laboroteca')
    .replace(/el club laboroteca.*$/i, 'club laboroteca')
    .replace(/libro digital.*jubilacion/i, 'de cara a la jubilacion')
    .replace(/de cara a la jubilacion/i, 'de cara a la jubilacion')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'de cara a la jubilacion': 7994
};

// 🔁 BLOQUE IMPAGO – Cancela TODO al primer intento fallido, email claro y sin generar factura
async function handleStripeEvent(event) {
  // ---- IMPAGO EN INVOICE ----
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const email = (
      invoice.customer_email ||
      invoice.customer_details?.email ||
      invoice.subscription_details?.metadata?.email ||
      invoice.metadata?.email
    )?.toLowerCase().trim();

    const invoiceId = invoice.id;
    const enlacePago = 'https://www.laboroteca.es/membresia-club-laboroteca/';

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      console.error(`❌ [IMPAGO] Email inválido o ausente en metadata de la invoice ${invoiceId}`);
      return { error: 'email_invalido_o_ausente' };
    }

    // --- No procesar duplicados de impago ---
    const paymentIntentId = invoice.payment_intent || `sin_intent_${invoiceId}`;
    const docRefIntento = firestore.collection('intentosImpago').doc(paymentIntentId);
    const docSnapIntento = await docRefIntento.get();
    if (docSnapIntento.exists) {
      console.warn(`⛔️ [IMPAGO] Evento duplicado ignorado: ${paymentIntentId}`);
      return { received: true, duplicate: true };
    }

    // --- Recuperar nombre (si hay) ---
    let nombre = invoice.customer_details?.name || '';
    if (!nombre && email) {
      try {
        const docSnap = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
        if (docSnap.exists) {
          const doc = docSnap.data();
          nombre = doc.nombre || '';
          console.log(`✅ Nombre recuperado para ${email}: ${nombre}`);
        }
      } catch (err) {
        console.error('❌ Error al recuperar nombre desde Firestore:', err.message);
      }
    }

    // --- Enviar email y desactivar membresía inmediatamente ---
    try {
      console.log(`⛔️ Primer intento de cobro fallido, CANCELANDO suscripción y SIN emitir factura para: ${email} – ${nombre}`);
      await enviarAvisoImpago(email, nombre, 1, enlacePago, true); // true = email de cancelación inmediata

      // ✅ Cancelar también la suscripción en Stripe
      const subscriptionId =
        invoice.subscription ||
        invoice.subscription_details?.subscription ||
        invoice.lines?.data?.[0]?.subscription ||
        invoice.metadata?.subscription ||
        null;

      console.log('🧪 Subscription ID extraído del invoice:', subscriptionId);

      console.log('📛 Intentando cancelar suscripción en Stripe ID:', subscriptionId);

      if (subscriptionId) {
        try {
          await stripe.subscriptions.del(subscriptionId);
          console.log(`✅ Suscripción cancelada en Stripe: ${subscriptionId}`);
        } catch (err) {
          console.error(`❌ Error al cancelar suscripción en Stripe (${subscriptionId}):`, err.message);
        }
      }

      await desactivarMembresiaClub(email, false);
      await registrarBajaClub({ email, motivo: 'impago' });
      await docRefIntento.set({
        invoiceId,
        email,
        nombre,
        fecha: new Date().toISOString()
      });
    } catch (err) {
      console.error('❌ Error al procesar impago/cancelación:', err?.message);
      return { error: 'fallo_envio_cancelacion' };
    }

    return { impago: 'cancelado_primer_intento' };
  }

  // ---- Captura también payment_intent.payment_failed (por si acaso) ----
  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const email = (
      intent.receipt_email ||
      intent.customer_email ||
      intent.metadata?.email
    )?.toLowerCase().trim();

    console.warn(`⚠️ [Intento fallido] payment_intent ${intent.id} falló para ${email || '[email desconocido]'}`);

    if (email && email.includes('@')) {
      try {
        await enviarAvisoImpago(email, 'cliente', 1, 'https://www.laboroteca.es/gestion-pago-club/', true);
        return { aviso_impago_por_payment_intent: true };
      } catch (err) {
        console.error('❌ Error al enviar aviso por payment_intent fallido:', err?.message);
        return { error: 'fallo_email_payment_intent' };
      }
    }

    return { warning: 'payment_intent_failed_sin_email' };
  }


// 📌 Evento: invoice.paid (renovación Club Laboroteca)
if (event.type === 'invoice.paid') {
  try {
    const invoice = event.data.object;
    const invoiceId = invoice.id;
    const customerId = invoice.customer;
    const billingReason = event.billing_reason || event.data.object.billing_reason;

    if (!invoiceId || !customerId) {
      console.warn('⚠️ Falta invoiceId o customerId en invoice.paid');
      return;
    }

    // ⚠️ IGNORAR facturas de tipo 'subscription_create' (compra inicial → ya procesada en checkout.session.completed)
    if (billingReason === 'subscription_create') {
      console.log(`ℹ️ Ignorado invoice.paid por compra inicial (billing_reason=subscription_create): ${invoiceId}`);
      return;
    }

    // ✅ Procesar facturas de tipo 'subscription_cycle' o manual si lleva 'Renovación' en la descripción
    const descripcion = (invoice.description || '').toLowerCase();
    if (
      billingReason !== 'subscription_cycle' &&
      !(billingReason === 'manual' && event.livemode === false)
    ) {
      console.log('📭 Ignorado evento no válido para facturación:', billingReason);
      return;
    }


    // ❌ Evitar duplicados por invoiceId
    const yaExiste = await firestore.collection('facturasEmitidas').doc(invoiceId).get();
    if (yaExiste.exists) {
      console.log(`🟡 Factura ya emitida para invoiceId: ${invoiceId}`);
      return;
    }

    // 🔍 Obtener email desde Stripe
    const customer = await stripe.customers.retrieve(customerId);
    const email = (customer.email || '').toLowerCase().trim();

    if (!email.includes('@')) {
      console.warn(`❌ Email no válido en invoice.paid: ${email}`);
      return;
    }

    // 📦 Recuperar datos fiscales guardados en la compra inicial
    const clienteDoc = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
    if (!clienteDoc.exists) {
      console.error(`❌ No se encontraron datos fiscales para ${email} en datosFiscalesPorEmail`);
      return;
    }

    const datosFiscales = clienteDoc.data();
    const nombre = datosFiscales.nombre || 'Cliente Laboroteca';
    const apellidos = datosFiscales.apellidos || '';

    const datosRenovacion = {
      ...datosFiscales,
      email,
      nombre,
      apellidos,
      nombreProducto: 'Renovación mensual Club Laboroteca',
      descripcionProducto: 'Renovación mensual Club Laboroteca',
      tipoProducto: 'Club',
      importe: (invoice.amount_paid || 999) / 100,
      invoiceId,
    };

    const pdfBuffer = await crearFacturaEnFacturaCity(datosRenovacion);
    await subirFactura(email, pdfBuffer, invoiceId);
    await guardarEnGoogleSheets(datosRenovacion);
    await enviarFacturaPorEmail(datosRenovacion, pdfBuffer);

    const emailSeguro = (email || '').toString().trim().toLowerCase();

    if (emailSeguro.includes('@')) {
      await activarMembresiaClub(emailSeguro);
      await syncMemberpressClub({
        email: emailSeguro,
        accion: 'activar',
        membership_id: 10663,
        importe: (invoice.amount_paid || 999) / 100
      });
    } else {
      console.warn(`❌ Email inválido en syncMemberpressClub: "${emailSeguro}"`);
    }

    await firestore.collection('facturasEmitidas').doc(invoiceId).set({
      procesada: true,
      fecha: new Date().toISOString(),
      email,
      tipo: 'renovacion'
    });


    console.log(`✅ Factura de renovación mensual procesada para ${email}`);
  } catch (error) {
    console.error('❌ Error al procesar invoice.paid:', error);
  }
}


  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const email = (
      subscription.metadata?.email ||
      subscription.customer_email ||
      subscription.customer_details?.email
    )?.toLowerCase().trim();

    const nombre = subscription.customer_details?.name || '';
    const enlacePago = 'https://www.laboroteca.es/membresia-club-laboroteca/';

    if (email) {
      try {
        console.log('❌ Suscripción cancelada por impago:', email);
        await desactivarMembresiaClub(email, false);
        await registrarBajaClub({ email, motivo: 'impago' });
        await enviarAvisoCancelacion(email, nombre, enlacePago);
      } catch (err) {
        console.error('❌ Error al registrar baja por impago:', err?.message);
      }
    }
    return { success: true, baja: true };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return { ignored: true };

    const sessionId = session.id;
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

    const name = (session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`).trim();
    const amountTotal = session.amount_total || 0;

    const rawNombreProducto = m.nombreProducto || '';
    const productoSlug = amountTotal === 999 ? 'el club laboroteca' : normalizarProducto(rawNombreProducto);
    const memberpressId = MEMBERPRESS_IDS[productoSlug];

    const descripcionProducto = m.descripcionProducto || rawNombreProducto || 'Producto Laboroteca';
    
    const productoNormalizado = normalizarProducto(rawNombreProducto); // <- mejor base para normalizar clave

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
      nombreProducto: rawNombreProducto,
      descripcionProducto,
      producto: productoNormalizado
    };

    console.log('📦 Procesando producto:', productoSlug, '-', datosCliente.importe, '€');

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

      await enviarFacturaPorEmail(datosCliente, pdfBuffer);

      
        // 🛡️ Guardar los datos del formulario solo si están completos
      if (
        datosCliente.nombre &&
        datosCliente.apellidos &&
        datosCliente.dni &&
        datosCliente.direccion &&
        datosCliente.ciudad &&
        datosCliente.provincia &&
        datosCliente.cp
      ) {
        await firestore.collection('datosFiscalesPorEmail').doc(email).set(datosCliente, { merge: true });
        console.log(`✅ Datos fiscales guardados para ${email}`);
      } else {
        console.warn(`⚠️ Datos incompletos. No se guardan en Firestore para ${email}`);
      }


      if (memberpressId === 10663) {
        await syncMemberpressClub({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
        await activarMembresiaClub(email);
      }

      if (memberpressId === 7994) {
        await syncMemberpressLibro({
          email,
          accion: 'activar',
          importe: datosCliente.importe
        });
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

  return { ignored: true };
}

module.exports = handleStripeEvent;
