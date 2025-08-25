const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail, enviarAvisoImpago, enviarConfirmacionBajaClub, enviarAvisoCancelacionManual, enviarEmailPersonalizado } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const { registrarBajaClub } = require('./registrarBajaClub');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const escapeHtml = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');
const crypto = require('crypto');
const redact = (v) => (process.env.NODE_ENV === 'production' ? hash12(String(v || '')) : String(v || ''));
const hash12 = e => crypto.createHash('sha256').update(String(e || '').toLowerCase()).digest('hex').slice(0,12);
const { ensureOnce } = require('../utils/dedupe');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// ——— Helpers comunes ———
async function nombreCompletoPorEmail(email, fallbackNombre = '', fallbackApellidos = '') {
  // 1) Si tengo nombre+apellidos en Firestore → uso eso
  try {
    const s = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
    if (s.exists) {
      const d = s.data() || {};
      const n = [d.nombre, d.apellidos].filter(Boolean).join(' ').trim();
      if (n) return n;
    }
  } catch (_) {}
  // 2) Si me pasan nombre/apellidos en memoria → combino
  const full = [fallbackNombre, fallbackApellidos].filter(Boolean).join(' ').trim();
  if (full) return full;
  // 3) Último fallback
  return (fallbackNombre || email.split('@')[0] || '').trim();
}

async function logBajaFirestore({
  email,
  nombre,
  motivo,                // 'impago' | 'eliminacion_cuenta' | 'voluntaria' | 'manual_inmediata' | 'manual_fin_ciclo'
  verificacion,          // 'CORRECTO' | 'FALLIDA' | 'PENDIENTE'
  fechaSolicitudISO,
  fechaEfectosISO,
  subscriptionId = null,
  source = 'stripe'
}) {
  const payload = {
    email,
    nombre: nombre || '',
    motivo,
    verificacion,
    fechaSolicitud: fechaSolicitudISO || new Date().toISOString(),
    fechaEfectos: fechaEfectosISO || new Date().toISOString(),
    subscriptionId,
    source,
    createdAt: new Date().toISOString()
  };
  try {
    await firestore.collection('bajasClubLog').add(payload);
  } catch (e) {
    await alertAdmin({ area: 'bajasClubLog', email, err: e, meta: payload });
  }
}

// ——— Helper: cargar metadata de FluentForms desde el Checkout Session que creó la suscripción
async function cargarFFDesdeCheckoutPorSubscription(subId) {
  if (!subId) return {};
  try {
    const lista = await stripe.checkout.sessions.list({ subscription: subId, limit: 1 });
    const s = lista?.data?.[0];
    return s?.metadata ? s.metadata : {};
  } catch (e) {
    console.warn('⚠️ No se pudo listar checkout.sessions por subscription:', e?.message || e);
    return {};
  }
}

function mapCancellationReason(subscription) {
  const det = subscription?.cancellation_details || {};
  // Valores típicos de Stripe:
  // 'payment_failed', 'requested_by_customer', 'cancellation_requested', 'incomplete_expired'
  if (det.reason === 'payment_failed') return 'impago';
  if (det.reason === 'requested_by_customer' || det.reason === 'cancellation_requested') return 'voluntaria';
  if (det.reason === 'incomplete_expired') return 'incompleta_expirada';
  return 'desconocida';
}


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
    let nombreCompleto = '';
    if (!nombre && email) {
      try {
        const docSnap = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
        if (docSnap.exists) {
          const doc = docSnap.data();
          const nComp = [doc.nombre, doc.apellidos].filter(Boolean).join(' ').trim();
          nombre = doc.nombre || '';
          nombreCompleto = nComp || '';
          console.log(`✅ Nombre recuperado para ${email}: ${nombre}`);
        }
      } catch (err) {
        console.error('❌ Error al recuperar nombre desde Firestore:', err.message);
      }
    }
    // Completar si no se armó arriba
    if (!nombreCompleto) nombreCompleto = await nombreCompletoPorEmail(email, nombre || '');

    // --- Enviar email y desactivar membresía inmediatamente ---
    try {
      console.log(`⛔️ Primer intento de cobro fallido, CANCELANDO suscripción y SIN emitir factura para: ${email} – ${nombre}`);
// ✅ Determinar subscriptionId primero
const subscriptionId =
  invoice.subscription ||
  invoice.subscription_details?.subscription ||
  invoice.lines?.data?.[0]?.subscription ||
  invoice.lines?.data?.[0]?.parent?.invoice_item_details?.subscription ||
  invoice.metadata?.subscription ||
  null;

// ⛔️ DEDUPE de BAJA por suscripción/email (evita doble baja e emails duplicados)
const bajaKey = `baja:${subscriptionId || email}`;
const isFirstBaja = await ensureOnce('bajasClub_idx', bajaKey);
if (!isFirstBaja) {
  console.warn(`⛔️ Baja ya registrada, omito acciones duplicadas (key=${bajaKey})`);
  return { received: true, duplicateBaja: true };
}


// 🔔 A partir de aquí SÍ enviamos el aviso/cancelamos (solo primera vez)
      await enviarAvisoImpago(email, nombreCompleto || nombre, 1, enlacePago, true);

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

      await registrarBajaClub({
        email,
        nombre: nombreCompleto || nombre,
        motivo: 'impago',
        verificacion: 'CORRECTO'
      });

      const docRefIntento = firestore.collection('intentosImpago').doc(paymentIntentId);

      await docRefIntento.set({
        invoiceId,
        email,
        nombre: nombreCompleto || nombre,
        fecha: new Date().toISOString()
      });

// (No escribimos la baja en Sheets: lo gestiona registrarBajaClub)

    } catch (err) {
      console.error('❌ Error al procesar impago/cancelación:', err?.message);
      await alertAdmin({
        area: 'impago_cancelacion',
        email,
        err,
        meta: { invoiceId }
      });
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
// ✅ Procesar compra inicial, renovaciones y (TEMPORAL) facturas manuales en TEST
function shouldProcessInvoicePaid(event, invoice) {
  const invoiceId = String(invoice?.id || '');
  const billingReason = String(invoice?.billing_reason || '');
  const isManual = billingReason === 'manual';
  const isAllowed =
    billingReason === 'subscription_create' ||
    billingReason === 'subscription_cycle' ||
    (isManual && event?.livemode === false); // permitir 'manual' solo en modo TEST

    // TODO: Revertir después → aceptar solo 'subscription_create' y 'subscription_cycle'

    };

// Etiqueta ALTA vs RENOVACIÓN
const isAlta = billingReason === 'subscription_create';
// Email base desde la invoice; fallback al customer
let email = (invoice.customer_email || invoice.customer_details?.email || '').toLowerCase().trim();
if (!email) {
  const cust = await stripe.customers.retrieve(customerId);
  email = (cust.email || '').toLowerCase().trim();
}
if (!email || !email.includes('@')) {
  console.warn(`❌ Email no válido en invoice.paid: ${email || '[vacío]'}`);
  return;
}


// 1) ALTA: PRIMERA fuente = FluentForms desde el Checkout Session que creó la suscripción
let subMeta = {};
if (isAlta && invoice.subscription) {
  const ffMeta = await cargarFFDesdeCheckoutPorSubscription(invoice.subscription);
  if (ffMeta && Object.keys(ffMeta).length > 0) {
    subMeta = { ...ffMeta };
  }
}

// 2) SEGUNDA fuente = subscription_details.metadata de la invoice (si viene, completa huecos)
const sdMeta = invoice.subscription_details?.metadata || {};
if (sdMeta && Object.keys(sdMeta).length > 0) {
  subMeta = { ...subMeta, ...sdMeta }; // lo de la invoice NO pisa lo ya traído de FF
}

// 3) TERCERA fuente (plan B): recuperar la suscripción de Stripe por si su metadata trae algo más
if (isAlta && invoice.subscription && Object.keys(subMeta).length === 0) {
  try {
    const subObj = await stripe.subscriptions.retrieve(invoice.subscription);
    const subM = subObj?.metadata || {};
    if (Object.keys(subM).length > 0) {
      subMeta = { ...subMeta, ...subM };
    }
  } catch (e) {
    console.warn('⚠️ No se pudo recuperar la suscripción para leer metadata FF:', e?.message || e);
  }
}

// 4) CUARTA fuente: metadata del Customer (la grabamos en checkout.session.completed)
try {
  const cust = await stripe.customers.retrieve(customerId);
  const custMeta = cust?.metadata || {};
  if (custMeta && Object.keys(custMeta).length > 0) {
    subMeta = { ...custMeta, ...subMeta }; // 🡐 Customer como base; mantén prioridad de FF si ya estaba
  }
} catch (e) {
  console.warn('⚠️ No se pudo recuperar customer.metadata:', e?.message || e);
}

// 5) QUINTA fuente: metadata de la propia invoice (si alguien la añadió)
const invMeta = invoice?.metadata || {};
if (invMeta && Object.keys(invMeta).length > 0) {
  subMeta = { ...subMeta, ...invMeta };
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
const subNombre     = pick(subMeta, 'nombre', 'first_name', 'Nombre', 'billing_first_name', 'billing_name', 'ff_nombre');
const subApellidos  = pick(subMeta, 'apellidos', 'last_name', 'Apellidos', 'billing_last_name', 'ff_apellidos');
const subDni        = pick(subMeta, 'dni','nif','NIF','DNI','vat','vat_number','vatnumber','tax_id','taxid','billing_nif','nif_cif');
const subDireccion  = pick(subMeta, 'direccion','address','billing_address_1','billing_address','address_line1','billing_line1','ff_direccion');
const subCiudad     = pick(subMeta, 'ciudad','city','billing_city','ff_ciudad');
const subProvincia  = pick(subMeta, 'provincia','state','region','billing_state','ff_provincia');
const subCp         = pick(subMeta, 'cp','codigo_postal','postal_code','postcode','postal','zip','billing_postcode','codigoPostal','ff_cp');
const subEmail      = pick(subMeta, 'email_autorelleno','email','correo','billing_email','ff_email');


// Preferimos el email de FluentForms en el ALTA (si vino en subMeta)
if (isAlta) {
  const emailFF = (subEmail || '').toLowerCase();
  if (emailFF && emailFF.includes('@')) {
    email = emailFF;
  }
}


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
  // ✅ ALTA: 1) FluentForms (subMeta) → 2) Firestore (base) → 3) Stripe (invoice/customer) → 4) Defaults
  nombre    = subNombre    || base.nombre    || nameFromStripe || 'Cliente Laboroteca';
  apellidos = subApellidos || base.apellidos || '';
  dni       = subDni       || base.dni       || dniFromStripe  || '';
  direccion = subDireccion || base.direccion || addr.line1     || '';
  ciudad    = subCiudad    || base.ciudad    || addr.city      || '';
  provincia = subProvincia || base.provincia || addr.state     || '';
  cp        = subCp        || base.cp        || addr.postal_code || '';

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

    // 🔐 Ficha básica del usuario (sin dirección postal)
    try {
      const uRef = firestore.collection('usuariosClub').doc(email);
      const uSnap = await uRef.get();
      const ahoraISO = new Date().toISOString();
      await uRef.set({
        email,
        nombre, apellidos, dni,
        activo: true,
        ultimaRenovacion: ahoraISO,
        ...(isAlta && (!uSnap.exists || !uSnap.data()?.fechaAlta) ? { fechaAlta: ahoraISO } : {})
      }, { merge: true });
    } catch (e) {
      console.warn('⚠️ usuariosClub set (invoice.paid):', e?.message || e);
    }

// 5) Si en ALTA no existía ficha, la guardamos *desde la fuente FF* para futuras renovaciones
if (isAlta && !snap.exists) {
  await docRef.set({
    nombre, apellidos, dni, direccion, ciudad, provincia, cp, email,
    origen: 'checkout.session.metadata@invoice.paid',
    fecha: new Date().toISOString()
  }, { merge: true });
  console.log(`ℹ️ (ALTA) Datos fiscales guardados desde subscription.metadata para ${email}`);
}


// Construcción de datos para Factura/Sheets
const datosRenovacion = {
  email, nombre, apellidos, dni, direccion, ciudad, provincia, cp,
  nombreProducto: isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca',
  descripcionProducto: isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca',
  tipoProducto: 'Club',
  producto: 'el club laboroteca',
  importe: (invoice.amount_paid ?? invoice.amount_due ?? 0) / 100,
  invoiceIdStripe: String(invoiceId) // <— SIEMPRE el de Stripe
};


let pdfBuffer = null;
let facturaId = null;
let seEnvioFactura = false;
let falloFactura = false;

const invoicingDisabled =
  String(process.env.DISABLE_INVOICING || '').toLowerCase() === 'true' ||
  process.env.DISABLE_INVOICING === '1';


if (invoicingDisabled) {
  console.warn(`⛔ Facturación deshabilitada (invoiceId=${invoiceId}). Saltando crear/subir/email. Registrando SOLO en Sheets.`);
try {
  await guardarEnGoogleSheets({ ...datosRenovacion, facturaId: '', uid: String(invoiceId), groupId: String(invoiceId) });

} catch (e) {
  console.error('❌ Sheets (kill-switch):', e?.message || e);
  await alertAdmin({
    area: 'sheets_registro',
    email,
    err: e,
    meta: { contexto: 'invoice.paid_kill_switch', datos: { ...datosRenovacion, facturaId: '' } }
  });
}
} else {
  try {
    const resFactura = await crearFacturaEnFacturaCity(datosRenovacion);
    pdfBuffer = resFactura?.pdfBuffer || resFactura || null;
    facturaId = resFactura?.facturaId || resFactura?.numeroFactura || null;

    if (!pdfBuffer) {
      console.warn('🟡 crearFacturaEnFacturaCity devolvió null (dedupe). No se sube ni se envía email. Registrando en Sheets.');
try {
  await guardarEnGoogleSheets({ ...datosRenovacion, facturaId: '', uid: String(invoiceId), groupId: String(invoiceId) });
} catch (e) {
  console.error('❌ Sheets (dedupe):', e?.message || e);
  await alertAdmin({
    area: 'sheets_registro',
    email,
    err: e,
    meta: { contexto: 'invoice.paid_dedupe', datos: { ...datosRenovacion, facturaId: '' } }
  });
}

    } else {
    // ✅ Registrar en Sheets con IDs separados (Stripe vs FacturaCity)
    const datosSheets = {
      ...datosRenovacion,                                   // ya incluye invoiceIdStripe
      facturaId: facturaId ? String(facturaId) : ''         // añade FacturaCity si existe
    };
    datosSheets.uid = String(facturaId || invoiceId);
    datosSheets.groupId = String(invoiceId);

    try {
      await guardarEnGoogleSheets(datosSheets);             // ← una sola llamada
} catch (e) {
  console.warn('⚠️ Sheets (invoice.paid) falló (ignorado):', e?.message || e);
  await alertAdmin({
    area: 'sheets_registro',
    email,
    err: e,
    meta: { contexto: 'invoice.paid', datos: datosSheets }
  });
}



// Segunda compuerta: no repetir subida/envío aunque hubiese doble PDF
const sendKey = facturaId ? `send:invoice:${facturaId}` : `send:invoice:${invoiceId}`;
const firstSend = await ensureOnce('sendFactura', sendKey);

if (!firstSend) {
  console.warn(`🟡 Dedupe envío/Upload para ${sendKey}. No repito subir/email.`);
} else {
  const fileId = (facturaId || invoiceId);
  const nombreArchivoGCS = `facturas/${hash12(email)}/${fileId}.pdf`;

  // Subida a GCS (no rompe el flujo si falla)
  try {
    await subirFactura(nombreArchivoGCS, pdfBuffer, {
      email,
      nombreProducto: datosRenovacion.nombreProducto,
      tipoProducto: datosRenovacion.tipoProducto,
      importe: datosRenovacion.importe
    });
  } catch (e) {
    console.error('❌ Subida GCS (invoice.paid):', e?.message || e);
    await alertAdmin({
      area: 'gcs_subida_factura',
      email,
      err: e,
      meta: { nombreArchivoGCS, invoiceId, facturaId }
    });
  }

  // Envío email factura (puede fallar sin romper webhook)
  try {
    await enviarFacturaPorEmail(datosSheets, pdfBuffer);
    seEnvioFactura = true;
  } catch (errEmailFactura) {
    console.error('❌ Error enviando la factura al cliente:', errEmailFactura?.message || errEmailFactura);
    falloFactura = true;
  }
}

    }


    } catch (e) {
      console.error('❌ Error facturación invoice.paid:', e?.message || e);
      falloFactura = true;

      // ✅ Registrar en Google Sheets AUNQUE falle FacturaCity
    try {
      await guardarEnGoogleSheets({ ...datosRenovacion, uid: String(invoiceId), groupId: String(invoiceId) });
    } catch (se) {
      console.error('❌ Sheets (invoice.paid catch):', se?.message || se);
      await alertAdmin({
        area: 'sheets_registro',
        email,
        err: se,
        meta: { contexto: 'invoice.paid_catch', datos: datosRenovacion }
      });
    }


      
    // (Opcional) Aviso al admin — versión completa
    try {
        const E = v => escapeHtml(String(v ?? '-'));
  const T = v => String(v ?? '-'); // para el texto plano

  await enviarEmailPersonalizado({
    to: 'laboroteca@gmail.com',
    subject: '⚠️ Factura fallida en invoice.paid',
    text: `Email: ${T(email)}
Nombre: ${T(nombre)} ${T(apellidos)}
DNI: ${T(dni)}
Dirección: ${T(direccion)}, ${T(cp)} ${T(ciudad)} (${T(provincia)})
Producto: ${T(datosRenovacion.nombreProducto)}
Importe: ${Number(datosRenovacion.importe).toFixed(2)} €
InvoiceId: ${T(invoiceId)}
Motivo (billing_reason): ${T(billingReason)} ${isAlta ? '(ALTA)' : '(RENOVACIÓN)'}
Error: ${T(e?.message || e)}`,
    html: `
      <h3>Factura fallida en invoice.paid</h3>
      <ul>
        <li><strong>Email:</strong> ${E(email)}</li>
        <li><strong>Nombre:</strong> ${E(nombre)} ${E(apellidos)}</li>
        <li><strong>DNI:</strong> ${E(dni)}</li>
        <li><strong>Dirección:</strong> ${E(direccion)}, ${E(cp)} ${E(ciudad)} (${E(provincia)})</li>
        <li><strong>Producto:</strong> ${E(datosRenovacion.nombreProducto)}</li>
        <li><strong>Importe:</strong> ${Number(datosRenovacion.importe).toFixed(2)} €</li>
        <li><strong>InvoiceId (Stripe):</strong> ${E(invoiceId)}</li>
        <li><strong>Motivo (billing_reason):</strong> ${E(billingReason)} ${isAlta ? '(ALTA)' : '(RENOVACIÓN)'}</li>
        <li><strong>Error:</strong> ${E(e?.message || e)}</li>
      </ul>
      <pre style="white-space:pre-wrap">${E(JSON.stringify(datosRenovacion, null, 2))}</pre>
    `
  });


    } catch (ea) {
      console.error('⚠️ Aviso admin (invoice.paid) falló:', ea?.message || ea);
    }

    }

    }


    const emailSeguro = (email || '').toString().trim().toLowerCase();

if (emailSeguro.includes('@')) {
  try {
    await activarMembresiaClub(emailSeguro, {
      activationRef: String(invoiceId),
      invoiceId: String(invoiceId),
      via: 'webhook:invoice.paid'
    });
  } catch (e) {
    console.error('❌ Activación Club (invoice.paid):', e?.message || e);
    await alertAdmin({
      area: 'activacion_membresia',
      email: emailSeguro,
      err: e,
      meta: { evento: 'invoice.paid' }
    });
  }
  try {
    await syncMemberpressClub({
      email: emailSeguro,
      accion: 'activar',
      membership_id: MEMBERPRESS_IDS['el club laboroteca'],
      importe: (invoice.amount_paid || 999) / 100
    });
  } catch (e) {
    console.error('❌ syncMemberpressClub (invoice.paid):', e?.message || e);
    await alertAdmin({
      area: 'sync_memberpress',
      email: emailSeguro,
      err: e,
      meta: { evento: 'invoice.paid' }
    });
  }
} else {

      console.warn(`❌ Email inválido en syncMemberpressClub: "${emailSeguro}"`);
    }

// 📧 Email de activación SOLO si falló la factura
if (falloFactura) {
  try {
    const fechaISO = new Date().toISOString();
    await enviarEmailPersonalizado({
      to: email,
      subject: '✅ Tu acceso al Club Laboroteca ya está activo',
      html: `
        <p>Hola ${nombre || 'cliente'},</p>
        <p>Tu <strong>membresía del Club Laboroteca</strong> ha sido <strong>activada correctamente</strong>.</p>
        <p><em>Hemos tenido un problema generando o enviando tu factura.</em> En cuanto esté disponible, te la enviaremos a este mismo correo.</p>
        <p><strong>Producto:</strong> ${isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca'}<br>
           <strong>Importe:</strong> ${((invoice.amount_paid ?? invoice.amount_due ?? 0)/100).toFixed(2).replace('.', ',')} €<br>
           <strong>Fecha:</strong> ${fechaISO}</p>
        <p><a href="https://www.laboroteca.es/mi-cuenta/">Accede a tu área de cliente</a></p>
      `,
      text: `Hola ${nombre || 'cliente'},

Tu membresía del Club Laboroteca ha sido activada correctamente.
Hemos tenido un problema generando o enviando tu factura. En cuanto esté disponible, te la enviaremos.

Producto: ${isAlta ? 'Alta y primera cuota Club Laboroteca' : 'Renovación mensual Club Laboroteca'}
Importe: ${((invoice.amount_paid ?? invoice.amount_due ?? 0)/100).toFixed(2)} €
Fecha: ${new Date().toISOString()}

Acceso: https://www.laboroteca.es/mi-cuenta/
`
    });
    console.log('✅ Email de activación (solo por fallo de factura) enviado');
  } catch (e) {
    console.error('❌ Error enviando email de activación por fallo de factura:', e?.message || e);
  }
} else {
  console.log('ℹ️ No se envía email de activación: la factura se generó y/o se envió correctamente.');
}



    await firestore.collection('facturasEmitidas').doc(invoiceId).set({
      procesada: true,
      fecha: new Date().toISOString(),
      email,
      tipo: isAlta ? 'alta' : 'renovacion'
    });


    console.log(`✅ Factura de ${isAlta ? 'ALTA' : 'RENOVACIÓN'} procesada para ${redact(email)}`);
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


    const subscriptionId = subscription.id || subscription.subscription || null;

    // ⛔️ DEDUPE de BAJA por suscripción/email
    const bajaKey = `baja:${subscriptionId || email}`;
    const isFirstBaja = await ensureOnce('bajasClub_idx', bajaKey);
    if (!isFirstBaja) {
      console.log(`🟡 customer.subscription.deleted duplicado (baja ya procesada) key=${bajaKey}`);
      return { duplicateBaja: true };
    }

    // Prioriza metadata propia si tu endpoint de baja la escribe:
    const motivoFromMeta    = subscription?.metadata?.motivo_baja;
    const origenBaja        = subscription?.metadata?.origen_baja || null;
    const comment           = subscription?.cancellation_details?.comment || '';
    const motivoFromComment = /eliminaci[oó]n[\s_-]*de?[\s_-]*cuenta|eliminacion_cuenta/i.test(comment)
      ? 'eliminacion_cuenta'
      : null;
    const motivo = motivoFromMeta || motivoFromComment || mapCancellationReason(subscription);
    const eraFinDeCiclo  = !!subscription?.cancel_at_period_end; // programada a fin de ciclo

    if (email) {
      try {
        console.log(`❌ Suscripción cancelada: ${email} (motivo=${motivo}, finDeCiclo=${eraFinDeCiclo})`);

        if (motivo === 'impago') {
          // ✅ Se mantiene tu comportamiento de baja inmediata (ya realizada)
          try {
            await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERPRESS_IDS['el club laboroteca'] });
            await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
            await registrarBajaClub({ email, motivo: 'impago' });
          // (Sin escritura en Sheets de bajas)
          } catch (e) {
            await alertAdmin({ area: 'deleted_impago_sync', email, err: e, meta: { subscriptionId } });
            throw e;
          }
          // No enviamos email aquí para evitar duplicados: el aviso de impago ya sale en invoice.payment_failed
         } else if (motivo === 'eliminacion_cuenta') {
           // 🔴 ELIMINACIÓN DE CUENTA → inmediata (única fila en Sheets)
          try {
             await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERPRESS_IDS['el club laboroteca'] });
             await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
             const nombreCompleto = await nombreCompletoPorEmail(email, nombre);
             await registrarBajaClub({ email, nombre: nombreCompleto, motivo: 'eliminacion_cuenta', verificacion: 'CORRECTO' });
             await logBajaFirestore({
               email,
               nombre: nombreCompleto,
               motivo: 'eliminacion_cuenta',
               verificacion: 'CORRECTO',
               fechaSolicitudISO: new Date().toISOString(),
               fechaEfectosISO: new Date().toISOString(),
               subscriptionId,
               source: 'stripe.subscription.deleted'
             });
           } catch (e) {
             await alertAdmin({ area: 'deleted_eliminacion_sync', email, err: e, meta: { subscriptionId } });
             throw e;
           }
            // No enviar email adicional: el flujo de eliminación ya avisa por su canal propio
          } else if (eraFinDeCiclo || origenBaja === 'formulario_usuario') {
            // 🟢 VOLUNTARIA ejecutada ahora (fin de ciclo)
          await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERPRESS_IDS['el club laboroteca'] });
          await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });

          // Firestore baja: ejecutada + correcto
          await firestore.collection('bajasClub').doc(email).set({
            estadoBaja: 'ejecutada',
            comprobacionFinal: 'correcto',
            fechaEjecucion: new Date().toISOString(),
            motivoFinal: 'voluntaria'
          }, { merge: true });
          
          // ✅ Actualizar la MISMA fila en Sheets (col F) con 'CORRECTO ✅' (sin crear otra)
          try {
            const { actualizarVerificacionBaja } = require('./registrarBajaClub');
            await actualizarVerificacionBaja({
            email,
            verificacion: 'CORRECTO ✅',
            strict: true,          // NO crear si no existe
            expectExisting: true   // forzar error si no la encuentra
          });
          } catch (_) {}
          // Log consolidado opcional
          try {
            const nombreCompleto = await nombreCompletoPorEmail(email, nombre);
            await logBajaFirestore({
              email,
              nombre: nombreCompleto,
              motivo: 'voluntaria',
              verificacion: 'CORRECTO',
              fechaSolicitudISO: new Date().toISOString(),
              fechaEfectosISO: new Date().toISOString(),
              subscriptionId,
              source: 'stripe.subscription.deleted'
            });
          } catch (_) {}

          await enviarConfirmacionBajaClub(email, nombre);

        } else {
          // 🟠 MANUAL INMEDIATA (dashboard u otros) → inmediata
            try {
            await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERPRESS_IDS['el club laboroteca'] });
            await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
            const nombreCompleto = await nombreCompletoPorEmail(email, nombre);
            await registrarBajaClub({
              email,
              nombre: nombreCompleto,
              motivo: 'manual_inmediata',
              verificacion: 'CORRECTO'
            });
            await logBajaFirestore({
              email,
              nombre: nombreCompleto,
              motivo: 'manual_inmediata',
              verificacion: 'CORRECTO',
              fechaSolicitudISO: new Date().toISOString(),
              fechaEfectosISO: new Date().toISOString(),
              subscriptionId,
              source: 'stripe.subscription.deleted'
            });
           
            // (Sin escritura en Sheets de bajas)

          } catch (e) {
            await alertAdmin({ area: 'deleted_manual_inmediata_sync', email, err: e, meta: { subscriptionId } });
            throw e;
          }
          // Email específico para manual inmediata (si lo quieres activar)
          if (typeof enviarAvisoCancelacionManual === 'function') {
            await enviarAvisoCancelacionManual(email, nombre);
          }
         }

      } catch (err) {
        console.error('❌ Error al registrar baja:', err?.message);
        await alertAdmin({ area: 'baja_membresia', email, err, meta: { motivo, subscriptionId } });
        
        // (Sin escritura en Sheets de bajas)

      }
    }
    return { success: true, baja: true };
   }
 
  // 🆕 Detectar programación de baja voluntaria (cancel_at_period_end=true)
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    if (sub.cancel_at_period_end) {
      // Registrar/actualizar baja programada (puede venir del dashboard o del formulario)
      const email = (
        sub.metadata?.email ||
        sub.customer_email ||
        sub.customer_details?.email
      )?.toLowerCase().trim();

      if (email) {
        const fechaEfectosISO = new Date((sub.current_period_end) * 1000).toISOString();
        const tipo = (sub.metadata?.origen_baja === 'formulario_usuario')
          ? 'voluntaria'
          : 'manual_fin_ciclo';

        // Sheets:
        //  - VOLUNTARIA → ya la escribió el servicio: NO duplicar
        //  - MANUAL_FIN_CICLO → SÍ registrar aquí
        try {
          if (tipo === 'manual_fin_ciclo') {
            // Fallback: nombre desde Stripe/Customer
            let fallbackName = sub.customer_details?.name || '';
            if (!fallbackName && sub.customer) {
              try { const c = await stripe.customers.retrieve(sub.customer); fallbackName = c?.name || ''; } catch {}
            }
            const nombreCompleto = await nombreCompletoPorEmail(email, fallbackName);
            await registrarBajaClub({
              email,
              nombre: nombreCompleto,
              motivo: 'manual_fin_ciclo',
              fechaSolicitud: new Date().toISOString(),
              fechaEfectos: fechaEfectosISO,
              verificacion: 'PENDIENTE',
            });
            await logBajaFirestore({
              email,
              nombre: nombreCompleto,
              motivo: 'manual_fin_ciclo',
              verificacion: 'PENDIENTE',
              fechaSolicitudISO: new Date().toISOString(),
              fechaEfectosISO: fechaEfectosISO,
              subscriptionId: sub.id,
              source: 'stripe.subscription.updated'
            });
          } else {
            console.log('↪️ Voluntaria programada detectada en webhook: NO se crea otra fila en Sheets.');
          }
        } catch (_) {}
        try {
          await firestore.collection('bajasClub').doc(email).set({
            tipoBaja: (sub.metadata?.origen_baja === 'formulario_usuario') ? 'voluntaria' : 'manual_fin_ciclo',
            origen: sub.metadata?.origen_baja || 'dashboard_admin',
            subscriptionId: sub.id,
            fechaSolicitud: new Date().toISOString(),
            fechaEfectos: fechaEfectosISO,
            estadoBaja: 'programada',
            comprobacionFinal: 'pendiente'
          }, { merge: true });
        } catch (e) {
          await alertAdmin({ area: 'baja_programada_firestore', email, err: e, meta: { subscriptionId: sub.id, fechaEfectosISO } });
        }
        
        // (Sin escritura en Sheets de bajas; solo Firestore)

        console.log(`📝 Registrada baja programada para ${email} (efectos=${fechaEfectosISO})`);
      }
    }
    return { noted_subscription_updated: true };
  }

if (event.type === 'checkout.session.completed') {
  const session = event.data.object;


  let errorProcesando = false;   // declaración única
    

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
      try {
  await firestore.collection('datosFiscalesPorEmail').doc(emailFF).set(payload, { merge: true });
} catch (e) {
  console.error('❌ Firestore datos fiscales (suscripción):', e?.message || e);
  await alertAdmin({
    area: 'firestore_datos_fiscales',
    email: emailFF,
    err: e,
    meta: { origen: 'checkout.session.completed(subscription)', datos: payload }
  });
}

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
    if (pi) datosCliente.invoiceIdStripe = String(pi); // ← NO toques invoiceId


    const tipoLower = ((m.tipoProducto || m.tipo || '').toLowerCase().trim());
    const totalAsistRaw =
      m.totalAsistentes ??
      m.total_asistentes ??
      m.numEntradas ??
      m.entradas ??
      m.tickets ??
      m.cantidadEntradas ??
      m.cantidad ??
      0;
    const totalAsist = Math.max(0, Math.floor(Number(totalAsistRaw) || 0));
    const esEntrada =
      tipoLower.includes('entrada') ||
      totalAsist > 0 ||
      /entrada|ticket|evento/i.test(m.nombreProducto || m.descripcionProducto || '');


    if (esEntrada) {
      datosCliente.tipoProducto = 'entrada';          // normalizamos
      datosCliente.totalAsistentes = totalAsist;      // ya es entero ≥ 0
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
        await activarMembresiaClub(email, {
          activationRef: String(pi || sessionId),
          paymentIntentId: pi ? String(pi) : null,
          via: 'webhook:checkout.session.completed'
        });
        await syncMemberpressClub({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
        console.log('✅ CLUB activado inmediatamente');
      } else if (memberpressId === 7994) {
        await syncMemberpressLibro({ email, accion: 'activar', importe: datosCliente.importe });
        console.log('✅ LIBRO activado inmediatamente');
      }
} catch (e) {
  console.error('❌ Error activando membresía (se registrará igualmente la compra):', e?.message || e);
  await alertAdmin({
    area: 'activacion_membresia',
    email,
    err: e,
    meta: { evento: 'checkout.session.completed', producto: productoSlug, membershipId: memberpressId }
  });
}


// (quitado) — La confirmación “Compra confirmada y acceso activado” SOLO se enviará más tarde
// y SOLO si la factura falla (para libro). Para entradas ya tienes su propio correo.

let pdfBuffer = null;
let seEnvioFactura = false;
let falloFactura = false;

try {
  const invoicingDisabled =
    String(process.env.DISABLE_INVOICING || '').toLowerCase() === 'true' ||
    process.env.DISABLE_INVOICING === '1';
  // (eliminada la línea "let pdfBuffer = null;" de aquí)

  if (invoicingDisabled) {
    console.warn('⛔ Facturación deshabilitada. Saltando crear/subir/email. Registrando SOLO en Sheets.');
    try {
      await guardarEnGoogleSheets({ ...datosCliente, uid: String(pi || sessionId || ''), groupId: String(pi || sessionId) });
} catch (e) {
  console.error('❌ Sheets (kill-switch):', e?.message || e);
  await alertAdmin({
    area: 'sheets_registro',
    email,
    err: e,
    meta: { contexto: 'checkout_kill_switch', datos: datosCliente }
  });
}

  } else {
    try {
      // 🧾 Intento de creación de factura (puede fallar sin cortar el flujo)
    const resFactura = await crearFacturaEnFacturaCity(datosCliente);
pdfBuffer = resFactura?.pdfBuffer || resFactura || null;
const facturaId = resFactura?.facturaId || resFactura?.numeroFactura || null;

if (!pdfBuffer) {
  console.warn('🟡 crearFacturaEnFacturaCity devolvió null (dedupe). Registro en Sheets pero NO subo a GCS ni envío factura.');
  try { await guardarEnGoogleSheets({ ...datosCliente, uid: String(pi || sessionId || '') }); } catch (e) { console.error('❌ Sheets (dedupe):', e?.message || e); }
} else {
// ✅ Registrar en Sheets con IDs separados (Stripe vs FacturaCity)
const datosSheets = {
  ...datosCliente,                                    // ← NO datosRenovacion
  invoiceIdStripe: pi ? String(pi) : '',              // ← PaymentIntent (único por pago)
  sessionId: sessionId ? String(sessionId) : '',
  facturaId: facturaId ? String(facturaId) : ''
};
datosSheets.uid = String(
  datosSheets.facturaId ||
  datosSheets.invoiceIdStripe ||
  datosSheets.sessionId ||
  sessionId ||
  pi ||
  ''
);
  datosSheets.groupId = String(pi || sessionId);

try {
  const sheetsKey = datosSheets.facturaId
  ? `sheets:factura:${datosSheets.facturaId}`
  : `sheets:pi:${datosSheets.invoiceIdStripe || datosSheets.sessionId}`;
  const firstSheetsWrite = await ensureOnce('sheets', sheetsKey);
  if (firstSheetsWrite) {
    await guardarEnGoogleSheets(datosSheets);
  } else {
    console.warn(`🟡 Dedupe Sheets: ya existe ${sheetsKey}, no registro de nuevo`);
  }
} catch (e) {
  console.warn('⚠️ Sheets (one-time) falló (ignorado):', e?.message || e);
  await alertAdmin({
    area: 'sheets_registro',
    email,
    err: e,
    meta: { contexto: 'checkout_one_time', datos: datosSheets }
  });
}


// 🔒 Gate para evitar IO duplicado
const baseName = (facturaId || pi || sessionId || Date.now());
const sendKey = `send:invoice:${baseName}`;
const firstSend = await ensureOnce('sendFactura', sendKey);

if (!firstSend) {
  console.warn(`🟡 Dedupe envío/Upload para ${sendKey}. No repito subir/email.`);
} else {
  const nombreArchivo = `facturas/${hash12(email)}/${baseName}-${datosCliente.producto}.pdf`;

  try {
    await subirFactura(nombreArchivo, pdfBuffer, {
      email,
      nombreProducto: datosCliente.nombreProducto || datosCliente.producto,
      tipoProducto: datosCliente.tipoProducto,
      importe: datosCliente.importe
    });
  } catch (e) {
    console.error('❌ Subida GCS (checkout.session.completed):', e?.message || e);
    await alertAdmin({
      area: 'gcs_subida_factura',
      email,
      err: e,
      meta: { nombreArchivo, baseName, pi, sessionId, facturaId },
      dedupeKey: `alert:gcs:${sendKey}`
    });

  }

  if (!esEntrada) {
    try {
      await enviarFacturaPorEmail(datosSheets, pdfBuffer);
      seEnvioFactura = true;
    } catch (errEmailFactura) {
      console.error('❌ Error enviando la factura al cliente (one-time):', errEmailFactura?.message || errEmailFactura);
      falloFactura = true;
    }
  }
}

}

    } catch (errFactura) {
      console.error('⛔ Error FacturaCity sin respuesta:', errFactura?.message || errFactura);

        falloFactura = true;

      // ⚠️ Continuamos el flujo sin factura
      pdfBuffer = null;

      // 🧾 Aún así, registramos la compra en Sheets (pago confirmado)
      try {
        await guardarEnGoogleSheets({ ...datosCliente, uid: String(pi || sessionId || ''), groupId: String(pi || sessionId) });
    } catch (e) {
      console.error('❌ Sheets tras fallo de FacturaCity:', e?.message || e);
      await alertAdmin({
        area: 'sheets_registro',
        email,
        err: e,
        meta: { contexto: 'checkout_catch_facturacity', datos: datosCliente }
      });
    }

// 🔔 Aviso al admin del fallo de factura con TODOS los datos del formulario (ESCAPADO)
try {
  const E = v => escapeHtml(String(v ?? '-'));
  const T = v => String(v ?? '-');
  const fechaCompraISO = new Date().toISOString();

  const detallesTexto = `
==== DATOS DE LA COMPRA (FACTURA FALLIDA) ====
- Nombre: ${T(datosCliente.nombre)}
- Apellidos: ${T(datosCliente.apellidos)}
- DNI: ${T(datosCliente.dni)}
- Email: ${T(email || datosCliente.email)}
- Tipo de producto: ${T(datosCliente.tipoProducto)}
- Nombre del producto: ${T(datosCliente.nombreProducto || datosCliente.producto)}
- Descripción del producto: ${T(datosCliente.descripcionProducto)}
- Importe (€): ${typeof datosCliente.importe === 'number' ? datosCliente.importe.toFixed(2) : '-'}
- Fecha de la compra (ISO): ${fechaCompraISO}

-- Dirección de facturación --
- Dirección: ${T(datosCliente.direccion)}
- Ciudad: ${T(datosCliente.ciudad)}
- CP: ${T(datosCliente.cp)}
- Provincia: ${T(datosCliente.provincia)}

-- Datos adicionales --
- Total asistentes (si aplica): ${T(datosCliente.totalAsistentes ?? '-')}
- Session ID: ${T(sessionId)}
- Payment Intent: ${T(pi)}
- Error FacturaCity: ${T(errFactura?.message || String(errFactura))}
`.trim();

  const detallesHTML = `
    <h3>Datos de la compra (factura fallida)</h3>
    <ul>
      <li><strong>Nombre:</strong> ${E(datosCliente.nombre)}</li>
      <li><strong>Apellidos:</strong> ${E(datosCliente.apellidos)}</li>
      <li><strong>DNI:</strong> ${E(datosCliente.dni)}</li>
      <li><strong>Email:</strong> ${E(email || datosCliente.email)}</li>
      <li><strong>Tipo de producto:</strong> ${E(datosCliente.tipoProducto)}</li>
      <li><strong>Nombre del producto:</strong> ${E(datosCliente.nombreProducto || datosCliente.producto)}</li>
      <li><strong>Descripción del producto:</strong> ${E(datosCliente.descripcionProducto)}</li>
      <li><strong>Importe (€):</strong> ${typeof datosCliente.importe === 'number' ? datosCliente.importe.toFixed(2) : '-'}</li>
      <li><strong>Fecha de la compra (ISO):</strong> ${E(fechaCompraISO)}</li>
    </ul>
    <h4>Dirección de facturación</h4>
    <ul>
      <li><strong>Dirección:</strong> ${E(datosCliente.direccion)}</li>
      <li><strong>Ciudad:</strong> ${E(datosCliente.ciudad)}</li>
      <li><strong>CP:</strong> ${E(datosCliente.cp)}</li>
      <li><strong>Provincia:</strong> ${E(datosCliente.provincia)}</li>
    </ul>
    <h4>Datos adicionales</h4>
    <ul>
      <li><strong>Total asistentes (si aplica):</strong> ${E(datosCliente.totalAsistentes ?? '-')}</li>
      <li><strong>Session ID:</strong> ${E(sessionId)}</li>
      <li><strong>Payment Intent:</strong> ${E(pi)}</li>
      <li><strong>Error FacturaCity:</strong> ${E(errFactura?.message || errFactura)}</li>
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

  // 📧 Email de apoyo SOLO si la factura FALLÓ (aplica al LIBRO)
// - No para entradas (tienen su correo propio)
// - No para el club (se gestiona en invoice.paid)
if (!esEntrada && memberpressId === 7994 && falloFactura) {
  try {
    const ahoraISO = new Date().toISOString();
    const productoLabel = datosCliente.nombreProducto || datosCliente.producto || 'Libro Laboroteca';
    await enviarEmailPersonalizado({
      to: email,
      subject: '✅ Acceso activo — estamos generando tu factura',
      html: `
        <p>Hola ${datosCliente.nombre || 'cliente'},</p>
        <p>Tu <strong>compra del libro</strong> <strong>${productoLabel}</strong> se ha procesado correctamente y tu acceso ya está <strong>activado</strong>.</p>
        <p><em>Hemos tenido un problema generando o enviando tu factura.</em> En cuanto esté disponible, te la enviaremos a este mismo correo.</p>
        <p><strong>Importe:</strong> ${datosCliente.importe.toFixed(2).replace('.', ',')} €<br>
           <strong>Fecha:</strong> ${ahoraISO}</p>
        <p><a href="https://www.laboroteca.es/mi-cuenta/">Accede a tu área de cliente</a></p>
      `,
      text: `Hola ${datosCliente.nombre || 'cliente'},

Tu compra del libro ${productoLabel} se ha procesado correctamente y tu acceso ya está activado.
Hemos tenido un problema generando o enviando tu factura. En cuanto esté disponible, te la enviaremos.

Importe: ${datosCliente.importe.toFixed(2)} €
Fecha: ${ahoraISO}

Acceso: https://www.laboroteca.es/mi-cuenta/
`
    });
    console.log('✅ Email de apoyo (solo por fallo de factura en LIBRO) enviado');
  } catch (e) {
    console.error('❌ Error enviando email de apoyo (libro):', e?.message || e);
  }
} else {
  console.log(`ℹ️ Email de apoyo NO enviado (esEntrada=${esEntrada}, esLibro=${memberpressId === 7994}, falloFactura=${falloFactura}, seEnvioFactura=${seEnvioFactura})`);
}

// 🎫 Procesar ENTRADAS en background + dedupe por sesión
if (esEntrada) {
  const kJob = `entradas:${session.id}`;
  const firstJob = await ensureOnce('jobs', kJob); // atómico
  if (firstJob) {
    const procesarEntradas = require('../entradas/services/procesarEntradas');
    // no await: no bloquea el webhook
    Promise.resolve()
      .then(() => procesarEntradas({ session, datosCliente, pdfBuffer })) // pdfBuffer puede ser null
      .then(() => console.log('🎫 procesarEntradas lanzado (async) job=', kJob))
      .catch(async err => {
  console.error('❌ procesarEntradas async:', err?.message || err);
  await alertAdmin({
    area: 'entradas_async',
    email,
    err,
    meta: { sessionId: session?.id, totalAsistentes: datosCliente?.totalAsistentes }
  });
});

  } else {
    console.log('🟡 procesarEntradas ya encolado/ejecutado para', session.id);
  }
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
    try {
  await firestore.collection('datosFiscalesPorEmail').doc(email).set(datosCliente, { merge: true });
  console.log(`✅ Datos fiscales guardados para ${email}`);
} catch (e) {
  console.error('❌ Firestore datos fiscales (final):', e?.message || e);
  await alertAdmin({
    area: 'firestore_datos_fiscales',
    email,
    err: e,
    meta: { origen: 'checkout.session.completed(final)', datos: datosCliente }
  });
}

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
