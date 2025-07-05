// services/handleStripeEvent.js

const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const desactivarMembresiaClub = require('./desactivarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');

const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

const MEMBERPRESS_IDS = {
  'El Club Laboroteca': 10663,
  'De cara a la jubilación': 7994
};

function plantillaImpago(n, nombre, link) {
  if (n === 1) return `Estimado ${nombre}. Tu pago de la membresía Club Laboroteca no se ha podido procesar. Lo intentaremos de nuevo en 2 días.<br><br><a href="${link}">Actualizar tarjeta</a>`;
  if (n === 2) return `Estimado ${nombre}. Segundo intento fallido. Si el próximo pago falla, se cancelará la suscripción.<br><br><a href="${link}">Actualizar tarjeta</a>`;
  if (n === 3) return `Estimado ${nombre}. Tu suscripción ha sido cancelada por impago. Puedes reactivarla desde tu cuenta.<br><br><a href="${link}">Actualizar tarjeta</a>`;
  return '';
}

async function handleStripeEvent(event) {
  const type = event.type;

  // ✅ CHECKOUT SESSION COMPLETED
  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;

    if (session.payment_status !== 'paid') return { ignored: true };

    const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
    if ((await docRef.get()).exists) return { duplicate: true };

    const m = session.metadata || {};
    const email = m.email_autorelleno || m.email || session.customer_details?.email || '';
    const name = session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`.trim();
    const amountTotal = session.amount_total || 0;

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
      nombreProducto: m.nombreProducto || '',
      descripcionProducto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido',
      producto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido'
    };

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
        console.error('❌ Error enviando email con factura:', err.message);
      }

      const productId = MEMBERPRESS_IDS[datosCliente.nombreProducto];
      if (productId) {
        await syncMemberpressClub({ email, accion: 'activar', membership_id: productId });
      }

      if (datosCliente.nombreProducto === 'El Club Laboroteca') {
        await activarMembresiaClub(email);
      }

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
          console.error('❌ Error marcando cupón como usado:', err);
        }
      }
    } finally {
      await docRef.set({
        sessionId,
        email,
        producto: datosCliente.producto,
        fecha: new Date().toISOString(),
        facturaGenerada: true
      });
    }

    return { success: true };
  }

  // ❌ INVOICE PAYMENT FAILED
  if (type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    const customerId = invoice.customer;
    const email = invoice.customer_email || invoice.metadata?.email || '';
    const name = invoice.customer_name || '';
    const nombreProducto = invoice.lines?.data?.[0]?.description || '';

    let updateUrl = 'https://www.laboroteca.es/mi-cuenta';
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: updateUrl
      });
      updateUrl = portal.url;
    } catch (err) {
      console.error('❌ Error creando portal de pago:', err.message);
    }

    const ref = firestore.collection('suscripcionesImpago').doc(subscriptionId);
    const doc = await ref.get();
    let fallos = doc.exists ? doc.data().fallos || 0 : 0;
    fallos++;

    await ref.set({
      subscriptionId,
      email,
      nombreProducto,
      fallos,
      fecha: new Date().toISOString()
    }, { merge: true });

    if (nombreProducto.includes('Club Laboroteca')) {
      const { enviarEmailAvisoImpago } = require('./emailAvisos');

      if (fallos <= 2) {
        await enviarEmailAvisoImpago({
          to: email,
          subject: 'Fallo en el cobro de tu suscripción',
          body: plantillaImpago(fallos, name || email, updateUrl)
        });
      }

      if (fallos >= 3) {
        try {
          await stripe.subscriptions.cancel(subscriptionId, {
            invoice_now: true,
            prorate: false
          });

          await syncMemberpressClub({
            email,
            accion: 'desactivar',
            membership_id: MEMBERPRESS_IDS['El Club Laboroteca']
          });

          await desactivarMembresiaClub(email);

          await enviarEmailAvisoImpago({
            to: email,
            subject: 'Suscripción cancelada por impago',
            body: plantillaImpago(3, name || email, updateUrl)
          });

          await enviarEmailAvisoImpago({
            to: 'laboroteca@gmail.com',
            subject: '🔔 [Laboroteca] Suscripción cancelada',
            body: `El usuario ${email} (${name}) ha sido dado de baja por impago.`
          });
        } catch (err) {
          console.error('❌ Error cancelando por impago:', err.message);
        }
      }
    }

    return { impago: true, fallos };
  }

  // 🗑️ SUSCRIPCIÓN ELIMINADA
  if (type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    let email = subscription.metadata?.email || '';

    if (!email && subscription.customer) {
      try {
        const cliente = await stripe.customers.retrieve(subscription.customer);
        email = cliente.email || '';
      } catch (err) {
        console.error('❌ No se pudo recuperar email del cliente:', err.message);
      }
    }

    const nombreProducto = subscription.metadata?.nombreProducto || subscription.items?.data?.[0]?.description || '';
    if (email && nombreProducto.includes('Club Laboroteca')) {
      try {
        await syncMemberpressClub({
          email,
          accion: 'desactivar',
          membership_id: MEMBERPRESS_IDS['El Club Laboroteca']
        });

        await desactivarMembresiaClub(email);

        await firestore.collection('bajasProcesadas').add({
          email,
          subscriptionId: subscription.id,
          fecha: new Date().toISOString()
        });
      } catch (err) {
        console.error('❌ Error en baja manual:', err.message);
      }
    }

    return { baja: true };
  }

  // 💤 Evento ignorado
  console.log(`ℹ️ Evento ignorado: ${type}`);
  return { ignored: true };
}

module.exports = handleStripeEvent;
