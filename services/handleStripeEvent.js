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
const { ensureOnce } = require('../utils/dedupe');


const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // ← esta línea
    .replace(/\./g, '')
    .replace(/suscripcion mensual (a|al)? el? club laboroteca.*$/i, 'club laboroteca')
    .replace(/el club laboroteca.*$/i, 'club laboroteca')
    .replace(/libro digital.*jubilacion/i, 'de cara a la jubilacion')
    .replace(/de cara a la jubilacion/i, 'de cara a la jubilacion')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}



const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'club laboroteca': 10663,
  'de cara a la jubilacion': 7994
};

// 🔁 BLOQUE IMPAGO – Cancela TODO al primer intento fallido, email claro y sin generar factura
async function handleStripeEvent(event) {
  // Idempotencia global por evento Stripe
const firstEvent = await ensureOnce('events', event.id);
if (!firstEvent) {
  console.warn(`🟡 Evento repetido ignorado: ${event.id} (${event.type})`);
  return { duplicateEvent: true };
}

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

    // --- No procesar duplicados de impago (atómico) ---
    const paymentIntentId = invoice.payment_intent || `sin_intent_${invoiceId}`;
    const unicoImpago = await ensureOnce('intentosImpago', paymentIntentId);
    if (!unicoImpago) {
      console.warn(`⛔️ [IMPAGO] Duplicado ignorado: ${paymentIntentId}`);
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
        invoice.lines?.data?.[0]?.parent?.invoice_item_details?.subscription ||
        invoice.metadata?.subscription ||
        null;


      console.log('🧪 Subscription ID extraído del invoice:', subscriptionId);

      console.log('📛 Intentando cancelar suscripción en Stripe ID:', subscriptionId);

      if (subscriptionId) {
        try {
          await stripe.subscriptions.cancel(subscriptionId);
          console.log(`✅ Suscripción cancelada en Stripe: ${subscriptionId}`);
        } catch (err) {
          console.error(`❌ Error al cancelar suscripción en Stripe (${subscriptionId}):`, err.message);
        }
      }

      await syncMemberpressClub({
        email,
        accion: 'desactivar',
        membership_id: MEMBERPRESS_IDS['el club laboroteca']
      });

      await firestore.collection('usuariosClub').doc(email).set({
        activo: false,
        fechaBaja: new Date().toISOString()
      }, { merge: true });

      await registrarBajaClub({ email, motivo: 'impago' });

      const docRefIntento = firestore.collection('intentosImpago').doc(paymentIntentId);

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
    const billingReason = invoice.billing_reason;

    if (!invoiceId || !customerId) {
      console.warn('⚠️ Falta invoiceId o customerId en invoice.paid');
      return;
    }

    // ✅ Procesar compra inicial y renovaciones del Club
    // Aceptamos 'subscription_create' (primera cuota) y 'subscription_cycle' (renovaciones).
    if (!['subscription_create', 'subscription_cycle'].includes(billingReason)) {
      console.log(`📭 invoice.paid ignorado (billing_reason=${billingReason}) invoiceId=${invoiceId}`);
      return;
    }


    // 📧 Email preferente de la invoice; fallback al customer de Stripe
    let email = (invoice.customer_email || invoice.customer_details?.email || '').toLowerCase().trim();
    if (!email) {
      const cust = await stripe.customers.retrieve(customerId);
      email = (cust.email || '').toLowerCase().trim();
    }

    if (!email || !email.includes('@')) {
      console.warn(`❌ Email no válido en invoice.paid: ${email || '[vacío]'}`);
      return;
    }


    // 🔎 Carga/crea ficha fiscal
    const docRef = firestore.collection('datosFiscalesPorEmail').doc(email);
    const snap = await docRef.get();

    const addr = invoice.customer_address || invoice.customer_details?.address || {};
    const nameFromStripe = invoice.customer_details?.name || '';
    const dniFromStripe  = invoice.customer_tax_ids?.[0]?.value || '';

    const base = snap.exists ? (snap.data() || {}) : {};

    const nombre    = base.nombre    || nameFromStripe || 'Cliente Laboroteca';
    const apellidos = base.apellidos || '';
    const dni       = base.dni       || dniFromStripe || '';
    const direccion = base.direccion || addr.line1 || '';
    const ciudad    = base.ciudad    || addr.city || '';
    const provincia = base.provincia || addr.state || '';
    const cp        = base.cp        || addr.postal_code || '';

    // Si no existía ficha, la persistimos para futuras renovaciones
    if (!snap.exists) {
      await docRef.set({
        nombre, apellidos, dni, direccion, ciudad, provincia, cp, email,
        origen: 'invoice.paid',
        fecha: new Date().toISOString()
      }, { merge: true });
      console.log(`ℹ️ Datos fiscales creados desde invoice.paid para ${email}`);
    }

    // Etiqueta ALTA vs RENOVACIÓN
    const isAlta = billingReason === 'subscription_create';

    const datosRenovacion = {
      email,
      nombre,
      apellidos,
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      nombreProducto: isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca',
      descripcionProducto: isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca',
      tipoProducto: 'Club',
      producto: 'el club laboroteca',
      importe: (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100,
      invoiceId,
    };


    const invoicingDisabled =
      String(process.env.DISABLE_INVOICING || '').toLowerCase() === 'true' ||
      process.env.DISABLE_INVOICING === '1';

    let pdfBuffer = null; //

    if (invoicingDisabled) {
      console.warn(`⛔ Facturación deshabilitada (invoiceId=${invoiceId}). Saltando crear/subir/email. Registrando SOLO en Sheets.`);
      try { await guardarEnGoogleSheets(datosRenovacion); } catch (e) { console.error('❌ Sheets (kill-switch):', e?.message || e); }
    } else {
      try {
        pdfBuffer = await crearFacturaEnFacturaCity(datosRenovacion);
        if (!pdfBuffer) {
          console.warn(`🟡 crearFacturaEnFacturaCity devolvió null (dedupe). No se sube ni se envía email. Registrando en Sheets.`);
          try { await guardarEnGoogleSheets(datosRenovacion); } catch (e) { console.error('❌ Sheets (dedupe):', e?.message || e); }

          } else {
      // Segunda compuerta: no repetir subida/envío aunque hubiese doble PDF
      const kSend = `send:invoice:${invoiceId}`;
      const firstSend = await ensureOnce('sendFactura', kSend);
      if (!firstSend) {
        console.warn(`🟡 Dedupe envío/Upload para ${kSend}. No repito subir/email.`);
      } else {
        const nombreArchivoGCS = `facturas/${email}/${invoiceId}.pdf`;
        await subirFactura(nombreArchivoGCS, pdfBuffer, {
          email,
          nombreProducto: datosRenovacion.nombreProducto,
          tipoProducto: datosRenovacion.tipoProducto,
          importe: datosRenovacion.importe
        });
        try {
  await guardarEnGoogleSheets(datosRenovacion);
  } catch (e) {
    console.warn('⚠️ Sheets (invoice.paid) falló (ignorado):', e?.message || e);
  }
  await enviarFacturaPorEmail(datosRenovacion, pdfBuffer);

      }
    }

      } catch (e) {
        console.error('❌ Error facturación invoice.paid:', e?.message || e);
        // opcional: rethrow si quieres parar el flujo
      }
    }


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
      tipo: isAlta ? 'alta' : 'renovacion'
    });


    console.log(`✅ Factura de ${isAlta ? 'ALTA' : 'RENOVACIÓN'} procesada para ${email}`);
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
    if (session.mode === 'subscription') {
      console.log('[checkout.session.completed] Suscripción: se factura en invoice.paid. Ignorado aquí.');
      return { ignored_subscription: true };
    }

    if (session.payment_status !== 'paid') return { ignored: true };

    const sessionId = session.id;
    const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
    await docRef.set({ sessionId, createdAt: new Date().toISOString() }, { merge: true });

    // ID de pago para dedupe de FacturaCity
    const pi = session.payment_intent || session.payment_intent_id || null;


    const m = session.metadata || {};
    const email = (
      (m.email_autorelleno && m.email_autorelleno.includes('@') && m.email_autorelleno) ||
      (m.email && m.email.includes('@') && m.email) ||
      (session.customer_details?.email && session.customer_details.email.includes('@') && session.customer_details.email) ||
      (session.customer_email && session.customer_email.includes('@') && session.customer_email)
    )?.toLowerCase().trim();

    if (!email) {
      console.error('❌ Email inválido en Stripe');
      await docRef.set({
        error: true,
        errorMsg: 'Email inválido en Stripe'
      }, { merge: true });
      return { error: 'Email inválido' };
    }


    const name = (session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`).trim();
    const amountTotal = session.amount_total || 0;

    const rawNombreProducto = m.nombreProducto || '';
    // Detecta Club sin depender del precio
    const nombreNorm = normalizarProducto(rawNombreProducto);
    const isClub =
      session.mode === 'subscription' ||                          // suscripciones van a invoice.paid
      (m.tipoProducto && m.tipoProducto.toLowerCase() === 'club') ||
      nombreNorm === 'el club laboroteca' || 
      nombreNorm === 'club laboroteca';


    const productoSlug = isClub ? 'club laboroteca' : nombreNorm;

    const memberpressId = MEMBERPRESS_IDS[productoSlug];

    const descripcionProducto = m.descripcionProducto || rawNombreProducto || 'Producto Laboroteca';

    console.log('🧪 handleStripeEvent - Precio y descripción recibida desde metadata:');
    console.log('👉 session.metadata.nombreProducto:', session.metadata?.nombreProducto);
    console.log('👉 session.metadata.descripcionProducto:', session.metadata?.descripcionProducto);
    console.log('👉 tipoProducto:', session.metadata?.tipoProducto);
    console.log('👉 totalAsistentes:', session.metadata?.totalAsistentes);

    
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

    // Reutilizamos la dedupe de FacturaCity: invoiceId = payment_intent
    if (pi) datosCliente.invoiceId = String(pi);

    if (productoNormalizado === 'entrada') {
      datosCliente.totalAsistentes = parseInt(m.totalAsistentes || '0');
    }

    console.log('📦 Procesando producto:', productoSlug, '-', datosCliente.importe, '€');

    // 🔐 GATE PAGO CONFIRMADO (PaymentIntent)
    const piId = session.payment_intent || session.payment_intent_id;
    if (!piId) {
      console.warn('⏸️ Sin PaymentIntent en session. No activo todavía.');
      await docRef.set({ error: true, errorMsg: 'Sin PaymentIntent en session' }, { merge: true });
      return { queued: true, motivo: 'sin_payment_intent' };
    }

    let piObj;
    try {
      piObj = await stripe.paymentIntents.retrieve(piId);
    } catch (e) {
      console.error('❌ No se pudo recuperar PaymentIntent:', e?.message || e);
      await docRef.set({ error: true, errorMsg: `PI retrieve error: ${e?.message || e}` }, { merge: true });
      return { queued: true, motivo: 'error_recuperando_pi' };
    }

    const pagoOk = (
      piObj?.status === 'succeeded' &&
      (piObj?.charges?.data?.[0]?.paid !== false)
    );

    if (!pagoOk) {
      console.warn(`⏸️ Pago aún NO confirmado (PI=${piObj?.status}, capture=${piObj?.capture_method}). No activo.`);
      await docRef.set({
        pendienteConfirmacionPago: true,
        piStatus: piObj?.status || 'desconocido',
        captureMethod: piObj?.capture_method || 'desconocido',
        updatedAt: new Date().toISOString()
      }, { merge: true });
      return { queued: true, motivo: 'pago_no_confirmado' };
    }
    // ✅ A partir de aquí, el pago está confirmado: se puede activar sin miedo.


        // 🔓 Activación inmediata (no bloqueada por Sheets/Email/GCS/FacturaCity)
    try {
      if (memberpressId === 10663) {
        await activarMembresiaClub(email);
        await syncMemberpressClub({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
        console.log('✅ CLUB activado inmediatamente');
      } else if (memberpressId === 7994) {
        await syncMemberpressLibro({ email, accion: 'activar', importe: datosCliente.importe });
        console.log('✅ LIBRO activado inmediatamente');
      }
    } catch (e) {
      console.error('❌ Error activando membresía (se registrará igualmente la compra):', e?.message || e);
    }


    let errorProcesando = false;
let pdfBuffer = null; // ← movido fuera del try para que esté accesible en finally

try {
  const invoicingDisabled =
    String(process.env.DISABLE_INVOICING || '').toLowerCase() === 'true' ||
    process.env.DISABLE_INVOICING === '1';
  // (eliminada la línea "let pdfBuffer = null;" de aquí)

  if (invoicingDisabled) {
    console.warn('⛔ Facturación deshabilitada. Saltando crear/subir/email. Registrando SOLO en Sheets.');
    try { await guardarEnGoogleSheets(datosCliente); } catch (e) { console.error('❌ Sheets (kill-switch):', e?.message || e); }
  } else {
    
    
    // 🧾 Crear factura SIEMPRE (la dedupe la hace FacturaCity por invoiceId = payment_intent)
pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);

if (!pdfBuffer) {
  console.warn('🟡 crearFacturaEnFacturaCity devolvió null (dedupe). No registro en Sheets ni subo a GCS.');
} else {
// ✅ Solo si FacturaCity devuelve factura real (no bloqueante)
  try {
    await guardarEnGoogleSheets(datosCliente);
  } catch (e) {
    console.warn('⚠️ Sheets falló (ignorado, no bloquea activación):', e?.message || e);
  }


  // 🔒 Gate SOLO de envío/subida para evitar IO duplicado
  const baseName = (pi || sessionId || Date.now());
  const kSend = `send:invoice:${baseName}`;
  const firstSend = await ensureOnce('sendFactura', kSend);
  if (!firstSend) {
    console.warn(`🟡 Dedupe envío/Upload para ${kSend}. No repito subir/email.`);
  } else {
    const nombreArchivo = `facturas/${email}/${baseName}-${datosCliente.producto}.pdf`;
    await subirFactura(nombreArchivo, pdfBuffer, {
      email,
      nombreProducto: datosCliente.nombreProducto || datosCliente.producto,
      tipoProducto: datosCliente.tipoProducto,
      importe: datosCliente.importe
    });

    if ((datosCliente.tipoProducto || '').toLowerCase() !== 'entrada') {
      await enviarFacturaPorEmail(datosCliente, pdfBuffer);
    }
  }
}


  }

  // 🎫 Procesar entradas SIEMPRE (aunque DISABLE_INVOICING sea true)
  if (datosCliente.tipoProducto?.toLowerCase() === 'entrada') {
    const procesarEntradas = require('../entradas/services/procesarEntradas');
    await procesarEntradas({ session, datosCliente, pdfBuffer }); // pdfBuffer puede ser null si kill-switch activo
  }

  // 🛡️ Guardar datos fiscales si están completos
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


} catch (err) {
  errorProcesando = true;
  console.error('❌ Error general en flujo Stripe (continuo, no bloqueo):', err?.message || err);

  // Registramos el error en Firestore pero NO lanzamos excepción
  await docRef.set({
    error: true,
    errorMsg: err?.message || String(err)
  }, { merge: true });

  // devolvemos objeto de error controlado, pero no rompemos el webhook
  return { success: false, mensaje: 'error_parcial', detalle: err?.message || String(err) };

} finally {
  await docRef.set({
    email,
    producto: datosCliente.producto,
    fecha: new Date().toISOString(),
    procesando: false,
    facturaGenerada: !!pdfBuffer,  // ← accesible siempre
    error: errorProcesando
  }, { merge: true });
}

return { success: true };
}

return { ignored: true };
}


module.exports = handleStripeEvent;
