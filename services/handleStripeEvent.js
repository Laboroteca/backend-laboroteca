const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail, enviarAvisoImpago, enviarAvisoCancelacion, enviarEmailPersonalizado } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const { registrarBajaClub } = require('./registrarBajaClub');
const desactivarMembresiaClub = require('./desactivarMembresiaClub');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { ensureOnce } = require('../utils/dedupe');


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

// Etiqueta ALTA vs RENOVACIÓN
const isAlta = billingReason === 'subscription_create';

    // 1) ALTA: intentar leer PRIMERO metadata embebida en la invoice (Stripe la incluye)
let subMeta = invoice.subscription_details?.metadata || {};

// Si sigue vacío, recuperamos la suscripción como plan B
if (isAlta && (!subMeta || Object.keys(subMeta).length === 0)) {
  try {
    if (invoice.subscription) {
      const subObj = await stripe.subscriptions.retrieve(invoice.subscription);
      subMeta = subObj?.metadata || {};
    }
  } catch (e) {
    console.warn('⚠️ No se pudo recuperar la suscripción para leer metadata FF:', e?.message || e);
  }
}

// Helper para coger la primera key válida
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

// Normalizamos posibles nombres de campos que puede mandar FF
const subNombre     = pick(subMeta, 'nombre', 'first_name', 'Nombre', 'billing_first_name');
const subApellidos  = pick(subMeta, 'apellidos', 'last_name', 'Apellidos', 'billing_last_name');
const subDni        = pick(subMeta, 'dni', 'nif', 'NIF', 'DNI', 'vat', 'vat_number');
const subDireccion  = pick(subMeta, 'direccion', 'address', 'billing_address_1', 'billing_address');
const subCiudad     = pick(subMeta, 'ciudad', 'city', 'billing_city');
const subProvincia  = pick(subMeta, 'provincia', 'state', 'region', 'billing_state');
const subCp         = pick(subMeta, 'cp', 'codigo_postal', 'postal_code', 'zip', 'billing_postcode');

console.log('🧾 invoice.paid • isAlta=', isAlta, '• subscription_details.metadata keys=', Object.keys(invoice.subscription_details?.metadata || {}));
console.log('🧾 invoice.paid • subMeta keys (final)=', Object.keys(subMeta || {}));


// 2) Cargamos posible ficha Firestore (fallback general y para renovaciones)
const docRef = firestore.collection('datosFiscalesPorEmail').doc(email);
const snap   = await docRef.get();
const base   = snap.exists ? (snap.data() || {}) : {};

// 3) Datos que puedan venir del invoice/customer de Stripe
const addr           = invoice.customer_address || invoice.customer_details?.address || {};
const nameFromStripe = invoice.customer_details?.name || '';
const dniFromStripe  = invoice.customer_tax_ids?.[0]?.value || '';

// 4) Selección de fuente según ALTA/RENOVACIÓN
let nombre, apellidos, dni, direccion, ciudad, provincia, cp;

if (isAlta) {
  // ✅ ALTA: prioridad a datos de Fluent Forms (con mapeo de claves)
  nombre    = subNombre    || nameFromStripe || 'Cliente Laboroteca';
  apellidos = subApellidos || '';
  dni       = subDni       || dniFromStripe  || '';
  direccion = subDireccion || addr.line1     || '';
  ciudad    = subCiudad    || addr.city      || '';
  provincia = subProvincia || addr.state     || '';
  cp        = subCp        || addr.postal_code || '';
} else {
  // 🔁 RENOVACIÓN: mantenemos tu comportamiento actual (Firestore -> Stripe)
  nombre    = (base.nombre    || nameFromStripe || 'Cliente Laboroteca');
  apellidos = (base.apellidos || '');
  dni       = (base.dni       || dniFromStripe  || '');
  direccion = (base.direccion || addr.line1     || '');
  ciudad    = (base.ciudad    || addr.city      || '');
  provincia = (base.provincia || addr.state     || '');
  cp        = (base.cp        || addr.postal_code || '');
}


// 5) Si en ALTA no existía ficha, la guardamos *desde la fuente FF* para futuras renovaciones
if (isAlta && !snap.exists) {
  await docRef.set({
    nombre, apellidos, dni, direccion, ciudad, provincia, cp, email,
    origen: 'subscription.metadata@invoice.paid',
    fecha: new Date().toISOString()
  }, { merge: true });
  console.log(`ℹ️ (ALTA) Datos fiscales guardados desde subscription.metadata para ${email}`);
}


// Construcción de datos para Factura/Sheets
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

let pdfBuffer = null;
let facturaId = null;

if (invoicingDisabled) {
  console.warn(`⛔ Facturación deshabilitada (invoiceId=${invoiceId}). Saltando crear/subir/email. Registrando SOLO en Sheets.`);
  try { await guardarEnGoogleSheets(datosRenovacion); } catch (e) { console.error('❌ Sheets (kill-switch):', e?.message || e); }
} else {
  try {
    const resFactura = await crearFacturaEnFacturaCity(datosRenovacion);
    pdfBuffer = resFactura?.pdfBuffer || resFactura || null;
    facturaId = resFactura?.facturaId || resFactura?.numeroFactura || null;

    if (!pdfBuffer) {
      console.warn('🟡 crearFacturaEnFacturaCity devolvió null (dedupe). No se sube ni se envía email. Registrando en Sheets.');
      try { await guardarEnGoogleSheets(datosRenovacion); } catch (e) { console.error('❌ Sheets (dedupe):', e?.message || e); }
    } else {
      // ✅ Registrar en Sheets la FACTURA usando el ID real si existe (antes del gate)
      const datosSheets = { ...datosRenovacion };
      if (facturaId) datosSheets.invoiceId = String(facturaId);

      try {
        await guardarEnGoogleSheets(datosSheets);
      } catch (e) {
        console.warn('⚠️ Sheets (invoice.paid) falló (ignorado):', e?.message || e);
      }

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
        await enviarFacturaPorEmail(datosSheets, pdfBuffer);
      }
    }


    } catch (e) {
      console.error('❌ Error facturación invoice.paid:', e?.message || e);

      // ✅ Registrar en Google Sheets AUNQUE falle FacturaCity
      try {
        await guardarEnGoogleSheets(datosRenovacion);
      } catch (se) {
        console.error('❌ Sheets (invoice.paid catch):', se?.message || se);
      }

      
    // (Opcional) Aviso al admin — versión completa
    try {
      const safe = v => (v === undefined || v === null || v === '') ? '-' : String(v);

      await enviarEmailPersonalizado({
        to: 'laboroteca@gmail.com',
        subject: '⚠️ Factura fallida en invoice.paid',
        text: `Email: ${safe(email)}
    Nombre: ${safe(nombre)} ${safe(apellidos)}
    DNI: ${safe(dni)}
    Dirección: ${safe(direccion)}, ${safe(cp)} ${safe(ciudad)} (${safe(provincia)})
    Producto: ${safe(datosRenovacion.nombreProducto)}
    Importe: ${Number(datosRenovacion.importe).toFixed(2)} €
    InvoiceId: ${safe(invoiceId)}
    Motivo (billing_reason): ${safe(billingReason)} ${isAlta ? '(ALTA)' : '(RENOVACIÓN)'}
    Error: ${safe(e?.message || e)}`,
        html: `
          <h3>Factura fallida en invoice.paid</h3>
          <ul>
            <li><strong>Email:</strong> ${safe(email)}</li>
            <li><strong>Nombre:</strong> ${safe(nombre)} ${safe(apellidos)}</li>
            <li><strong>DNI:</strong> ${safe(dni)}</li>
            <li><strong>Dirección:</strong> ${safe(direccion)}, ${safe(cp)} ${safe(ciudad)} (${safe(provincia)})</li>
            <li><strong>Producto:</strong> ${safe(datosRenovacion.nombreProducto)}</li>
            <li><strong>Importe:</strong> ${Number(datosRenovacion.importe).toFixed(2)} €</li>
            <li><strong>InvoiceId (Stripe):</strong> ${safe(invoiceId)}</li>
            <li><strong>Motivo (billing_reason):</strong> ${safe(billingReason)} ${isAlta ? '(ALTA)' : '(RENOVACIÓN)'}</li>
            <li><strong>Error:</strong> ${safe(e?.message || e)}</li>
          </ul>
          <pre style="white-space:pre-wrap">${safe(JSON.stringify(datosRenovacion, null, 2))}</pre>
        `
      });
    } catch (ea) {
      console.error('⚠️ Aviso admin (invoice.paid) falló:', ea?.message || ea);
    }

    }

    }


    const emailSeguro = (email || '').toString().trim().toLowerCase();

    if (emailSeguro.includes('@')) {
      await activarMembresiaClub(emailSeguro);
      await syncMemberpressClub({
        email: emailSeguro,
        accion: 'activar',
        membership_id: MEMBERPRESS_IDS['el club laboroteca'],
        importe: (invoice.amount_paid || 999) / 100
      });
    } else {
      console.warn(`❌ Email inválido en syncMemberpressClub: "${emailSeguro}"`);
    }

    // 📧 Email de confirmación de activación (Club)
    try {
      const fechaISO = new Date().toISOString();
      await enviarEmailPersonalizado({
        to: email,
        subject: '✅ Tu acceso al Club Laboroteca ya está activo',
        html: `
          <p>Hola ${nombre || 'cliente'},</p>
          <p>Tu <strong>membresía del Club Laboroteca</strong> ha sido <strong>activada correctamente</strong>.</p>
          <p><strong>Producto:</strong> ${isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca'}<br>
            <strong>Importe:</strong> ${((invoice.amount_paid ?? invoice.amount_due ?? 0)/100).toFixed(2).replace('.', ',')} €<br>
            <strong>Fecha:</strong> ${fechaISO}</p>
          <p>Puedes acceder a tu área:</p>
          <p><a href="https://www.laboroteca.es/mi-cuenta/">https://www.laboroteca.es/mi-cuenta/</a></p>
          <p>Gracias por confiar en Laboroteca.</p>
        `,
        text: `Hola ${nombre || 'cliente'},

    Tu membresía del Club Laboroteca ha sido activada correctamente.

    Producto: ${isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca'}
    Importe: ${((invoice.amount_paid ?? invoice.amount_due ?? 0)/100).toFixed(2)} €
    Fecha: ${fechaISO}

    Acceso: https://www.laboroteca.es/mi-cuenta/

    Gracias por confiar en Laboroteca.`
      });
      console.log('✅ Email de confirmación de Club enviado');
    } catch (e) {
      console.error('❌ Error enviando email de confirmación de Club:', e?.message || e);
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
    // Persistimos los datos del formulario (Fluent Forms) en Firestore
    const m = session.metadata || {};
    const emailFF = (
      (m.email && m.email.includes('@') && m.email) ||
      (session.customer_details?.email && session.customer_details.email) ||
      (session.customer_email && session.customer_email)
    )?.toLowerCase().trim();
    

    if (emailFF && emailFF.includes('@')) {
      const payload = {
        nombre:     m.nombre     || session.customer_details?.name || '',
        apellidos:  m.apellidos  || '',
        dni:        m.dni        || m.nif || '',
        direccion:  m.direccion  || '',
        ciudad:     m.ciudad     || '',
        provincia:  m.provincia  || '',
        cp:         m.cp         || m.codigo_postal || '',
        email:      emailFF,
        origen:     'fluentforms@checkout.session.completed',
        fecha:      new Date().toISOString()
      };
      await firestore.collection('datosFiscalesPorEmail').doc(emailFF).set(payload, { merge: true });
          // 💾 Copiamos los datos fiscales de Fluent Forms a la SUSCRIPCIÓN de Stripe
    try {
      const subId = session.subscription;
      if (subId) {
        await stripe.subscriptions.update(subId, {
          metadata: {
            email:     emailFF || '',
            nombre:    (m.nombre || session.customer_details?.name || '').trim(),
            apellidos: (m.apellidos || '').trim(),
            dni:       (m.dni || m.nif || '').trim(),
            direccion: (m.direccion || '').trim(),
            ciudad:    (m.ciudad || '').trim(),
            provincia: (m.provincia || '').trim(),
            cp:        (m.cp || m.codigo_postal || '').trim(),
            fuente:    'fluentforms'
          }
        });
      }
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar metadata de la suscripción con datos FF:', e?.message || e);
    }

    // Además, replicamos metadata en el Customer como backup
try {
  const custId = session.customer;
  if (custId) {
    await stripe.customers.update(custId, {
      metadata: {
        email: emailFF || '',
        nombre: (m.nombre || session.customer_details?.name || '').trim(),
        apellidos: (m.apellidos || '').trim(),
        dni: (m.dni || m.nif || '').trim(),
        direccion: (m.direccion || '').trim(),
        ciudad: (m.ciudad || '').trim(),
        provincia: (m.provincia || '').trim(),
        cp: (m.cp || m.codigo_postal || '').trim(),
        fuente: 'fluentforms'
      }
    });
  }
} catch (e) {
  console.warn('⚠️ No se pudo actualizar metadata del Customer con datos FF:', e?.message || e);
}

    // (Opcional recomendado) Actualizar también el Customer con la dirección
    try {
      const custId = session.customer;
      if (custId) {
        await stripe.customers.update(custId, {
          address: {
            line1: (m.direccion || '') || undefined,
            city: (m.ciudad || '') || undefined,
            postal_code: (m.cp || m.codigo_postal || '') || undefined,
            state: (m.provincia || '') || undefined,
            country: 'ES'
          },
          name: ((m.nombre || '') + ' ' + (m.apellidos || '')).trim() || undefined
        });
      }
    } catch (e) {
      console.warn('⚠️ No se pudo actualizar el Customer con dirección FF:', e?.message || e);
    }

      console.log(`✅ Datos fiscales (FF) guardados para suscripción: ${emailFF}`);
    } else {
      console.warn('⚠️ Suscripción: no se pudo determinar email para guardar datos FF.');
    }

    // Seguimos sin facturar aquí (la factura se hace en invoice.paid)
    return { noted_subscription_metadata: true };
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

    const tipoLower = (m.tipoProducto || '').toLowerCase().trim();
    const totalAsist = parseInt((m.totalAsistentes || '0'), 10);
    const esEntrada = tipoLower.startsWith('entrada') || totalAsist > 0;
    if (esEntrada) {
      datosCliente.tipoProducto = 'entrada';              // normalizamos
      datosCliente.totalAsistentes = isNaN(totalAsist) ? 0 : totalAsist;
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

   // 📧 Confirmación al usuario de compra + activación (NO enviar si es venta de entradas)
if (!esEntrada) {
  try {
    const productoLabel = datosCliente.nombreProducto || datosCliente.producto || 'Producto Laboroteca';
    const ahoraISO = new Date().toISOString();
    await enviarEmailPersonalizado({
      to: email,
      subject: '✅ Compra confirmada y acceso activado',
      html: `
        <p>Hola ${datosCliente.nombre || 'cliente'},</p>
        <p>Tu compra de <strong>${productoLabel}</strong> se ha procesado correctamente y tu acceso ya está <strong>activado</strong>.</p>
        <p><strong>Importe:</strong> ${datosCliente.importe.toFixed(2).replace('.', ',')} €<br>
           <strong>Fecha:</strong> ${ahoraISO}</p>
        <p>Puedes acceder a tu área:</p>
        <p><a href="https://www.laboroteca.es/mi-cuenta/">https://www.laboroteca.es/mi-cuenta/</a></p>
      `,
      text: `Hola ${datosCliente.nombre || 'cliente'},

Tu compra de ${productoLabel} se ha procesado correctamente y tu acceso ya está activado.

Importe: ${datosCliente.importe.toFixed(2)} €
Fecha: ${ahoraISO}

Área de cliente: https://www.laboroteca.es/mi-cuenta/
`
    });
    console.log('✅ Email de confirmación de compra+activación enviado (checkout.session.completed)');
  } catch (e) {
    console.error('❌ Error enviando email de confirmación de compra+activación:', e?.message || e);
  }
} else {
  console.log('ℹ️ Venta de entradas: NO se envía email de confirmación (se envía desde el flujo de entradas).');
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
    try {
      await guardarEnGoogleSheets(datosCliente);
    } catch (e) {
      console.error('❌ Sheets (kill-switch):', e?.message || e);
    }
  } else {
    try {
      // 🧾 Intento de creación de factura (puede fallar sin cortar el flujo)
    const resFactura = await crearFacturaEnFacturaCity(datosCliente);
pdfBuffer = resFactura?.pdfBuffer || resFactura || null;
const facturaId = resFactura?.facturaId || resFactura?.numeroFactura || null;

if (!pdfBuffer) {
  console.warn('🟡 crearFacturaEnFacturaCity devolvió null (dedupe). Registro en Sheets pero NO subo a GCS ni envío factura.');
  try { await guardarEnGoogleSheets(datosCliente); } catch (e) { console.error('❌ Sheets (dedupe):', e?.message || e); }
} else {
  // ✅ Registrar en Sheets la FACTURA usando el ID real si existe
  const datosSheets = { ...datosCliente };
  if (facturaId) datosSheets.invoiceId = String(facturaId);

  try {
    await guardarEnGoogleSheets(datosSheets);
  } catch (e) {
    console.warn('⚠️ Sheets falló (ignorado):', e?.message || e);
  }

  // 🔒 Gate para evitar IO duplicado
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

    if (!esEntrada) {
      await enviarFacturaPorEmail(datosSheets, pdfBuffer);
    }
  }
}

    } catch (errFactura) {
      console.error('⛔ Error FacturaCity sin respuesta:', errFactura?.message || errFactura);

      // ⚠️ Continuamos el flujo sin factura
      pdfBuffer = null;

      // 🧾 Aún así, registramos la compra en Sheets (pago confirmado)
      try {
        await guardarEnGoogleSheets(datosCliente);
      } catch (e) {
        console.error('❌ Sheets tras fallo de FacturaCity:', e?.message || e);
      }

      // 🔔 Aviso al admin del fallo de factura con TODOS los datos del formulario
      try {
        const fechaCompraISO = new Date().toISOString();

        const detallesTexto = `
  ==== DATOS DE LA COMPRA (FACTURA FALLIDA) ====
  - Nombre: ${datosCliente.nombre || '-'}
  - Apellidos: ${datosCliente.apellidos || '-'}
  - DNI: ${datosCliente.dni || '-'}
  - Email: ${email || datosCliente.email || '-'}
  - Tipo de producto: ${datosCliente.tipoProducto || '-'}
  - Nombre del producto: ${datosCliente.nombreProducto || datosCliente.producto || '-'}
  - Descripción del producto: ${datosCliente.descripcionProducto || '-'}
  - Importe (€): ${typeof datosCliente.importe === 'number' ? datosCliente.importe.toFixed(2) : '-'}
  - Fecha de la compra (ISO): ${fechaCompraISO}

  -- Dirección de facturación --
  - Dirección: ${datosCliente.direccion || '-'}
  - Ciudad: ${datosCliente.ciudad || '-'}
  - CP: ${datosCliente.cp || '-'}
  - Provincia: ${datosCliente.provincia || '-'}

  -- Datos adicionales --
  - Total asistentes (si aplica): ${datosCliente.totalAsistentes ?? '-'}
  - Session ID: ${sessionId || '-'}
  - Payment Intent: ${pi || '-'}
  - Error FacturaCity: ${errFactura?.message || String(errFactura)}
  `.trim();

        const detallesHTML = `
          <h3>Datos de la compra (factura fallida)</h3>
          <ul>
            <li><strong>Nombre:</strong> ${datosCliente.nombre || '-'}</li>
            <li><strong>Apellidos:</strong> ${datosCliente.apellidos || '-'}</li>
            <li><strong>DNI:</strong> ${datosCliente.dni || '-'}</li>
            <li><strong>Email:</strong> ${email || datosCliente.email || '-'}</li>
            <li><strong>Tipo de producto:</strong> ${datosCliente.tipoProducto || '-'}</li>
            <li><strong>Nombre del producto:</strong> ${datosCliente.nombreProducto || datosCliente.producto || '-'}</li>
            <li><strong>Descripción del producto:</strong> ${datosCliente.descripcionProducto || '-'}</li>
            <li><strong>Importe (€):</strong> ${typeof datosCliente.importe === 'number' ? datosCliente.importe.toFixed(2) : '-'}</li>
            <li><strong>Fecha de la compra (ISO):</strong> ${fechaCompraISO}</li>
          </ul>
          <h4>Dirección de facturación</h4>
          <ul>
            <li><strong>Dirección:</strong> ${datosCliente.direccion || '-'}</li>
            <li><strong>Ciudad:</strong> ${datosCliente.ciudad || '-'}</li>
            <li><strong>CP:</strong> ${datosCliente.cp || '-'}</li>
            <li><strong>Provincia:</strong> ${datosCliente.provincia || '-'}</li>
          </ul>
          <h4>Datos adicionales</h4>
          <ul>
            <li><strong>Total asistentes (si aplica):</strong> ${datosCliente.totalAsistentes ?? '-'}</li>
            <li><strong>Session ID:</strong> ${sessionId || '-'}</li>
            <li><strong>Payment Intent:</strong> ${pi || '-'}</li>
            <li><strong>Error FacturaCity:</strong> ${String(errFactura?.message || errFactura)}</li>
          </ul>
          <p>Nota: se continúa el flujo ${esEntrada ? 'enviando <strong>entradas</strong> sin factura' : 'sin enviar factura'}.</p>
        `.trim();

        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ Fallo al generar factura (checkout.session.completed)',
          text: detallesTexto,
          html: detallesHTML
        });
      } catch (eAviso) {
        console.error('⚠️ No se pudo avisar al admin del fallo de factura:', eAviso?.message || eAviso);
      }
    }
  }

  // 🎫 Procesar ENTRADAS SIEMPRE (aunque falle FacturaCity o DISABLE_INVOICING sea true)
  if (esEntrada) {
    const procesarEntradas = require('../entradas/services/procesarEntradas');
    await procesarEntradas({ session, datosCliente, pdfBuffer }); // pdfBuffer puede ser null
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
