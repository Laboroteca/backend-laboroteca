const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { desactivarMembresiaClub } = require('./desactivarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

// Cambia aquí los IDs de MemberPress para cada producto
const MEMBERPRESS_IDS = {
  'El Club Laboroteca': 10663,
  'De cara a la jubilación': 7994
  // Puedes añadir más: 'Nombre exacto del producto': ID
};

function plantillaImpago(n, nombre, link) {
  if (n === 1) return `Estimado ${nombre}. Tu pago de la membresía Club Laboroteca no se ha podido procesar. Lo intentaremos de nuevo en 2 días.<br><br>Puedes actualizar tu método de pago aquí: <a href="${link}">Actualizar tarjeta</a>`;
  if (n === 2) return `Estimado ${nombre}. Tu pago de la membresía Club Laboroteca no se ha podido procesar. Segundo intento de cobro fallido. Si el próximo pago falla, lamentamos decirte que tendremos que cancelar tu suscripción.<br><br>Puedes actualizar tu método de pago aquí: <a href="${link}">Actualizar tarjeta</a>`;
  if (n === 3) return `Estimado ${nombre}. Tu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento desde tu cuenta.<br><br>Puedes actualizar tu método de pago aquí: <a href="${link}">Actualizar tarjeta</a>`;
  return '';
}

async function handleStripeEvent(event) {
  const eventType = event.type;

  // === 1) COMPRA - FLUJO NORMAL ===
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

    // --- ACTIVAR MEMBRESÍA EN WORDPRESS SEGÚN PRODUCTO ---
    const productId = MEMBERPRESS_IDS[datosCliente.nombreProducto];
    if (productId && email) {
      try {
        await syncMemberpressClub({
          email,
          accion: 'activar',
          membership_id: productId
        });
        console.log(`✅ Sincronizado alta de ${datosCliente.nombreProducto} en MemberPress (${productId})`);
      } catch (err) {
        console.error(`❌ Error al activar en MemberPress [${productId}]:`, err);
      }
    }

    // Antiguo flujo Firestore (si lo mantienes)
    if (datosCliente.nombreProducto === 'El Club Laboroteca') {
      try {
        await activarMembresiaClub(email);
      } catch (err) {
        console.error('❌ Error al activar membresía del Club en Firestore:', err);
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

  // === 2) IMPAGOS ===
  if (eventType === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const subscriptionId = invoice.subscription;
    const customerId = invoice.customer;
    const email = invoice.customer_email || invoice.customer?.email || '';
    const name = invoice.customer_name || '';
    const nombreProducto = invoice.lines?.data?.[0]?.description || '';

    let updateUrl = '';
    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: 'https://www.laboroteca.es/mi-cuenta'
      });
      updateUrl = portalSession.url;
    } catch (err) {
      console.error('❌ Error al generar enlace de portal de cliente Stripe:', err);
      updateUrl = 'https://www.laboroteca.es/mi-cuenta';
    }

    const ref = firestore.collection('suscripcionesImpago').doc(subscriptionId);
    let fallos = 0;
    const doc = await ref.get();
    if (doc.exists) {
      fallos = doc.data().fallos || 0;
    }
    fallos += 1;
    await ref.set({
      subscriptionId,
      email,
      nombreProducto,
      fallos,
      fecha: new Date().toISOString()
    }, { merge: true });

    if (nombreProducto.includes('Club Laboroteca')) {
      const { enviarEmailAvisoImpago } = require('./emailAvisos');

      if (fallos === 1 || fallos === 2) {
        await enviarEmailAvisoImpago({
          to: email,
          subject: 'Fallo en el cobro de tu suscripción',
          body: plantillaImpago(fallos, name || email, updateUrl)
        });
        console.log(`📧 Aviso de impago ${fallos} enviado a ${email}`);
      }
      if (fallos >= 3) {
        // Cancela en Stripe la suscripción
        try {
          await stripe.subscriptions.del(subscriptionId);

          // --- DESACTIVAR EN MEMBERPRESS SEGÚN PRODUCTO ---
          const productId = MEMBERPRESS_IDS['El Club Laboroteca'];
          if (productId && email) {
            await syncMemberpressClub({
              email,
              accion: 'desactivar',
              membership_id: productId
            });
            console.log(`🚫 Sincronizado baja de Club Laboroteca en MemberPress (${productId})`);
          }

          await desactivarMembresiaClub(email);

          // Envía aviso de cancelación al usuario y a Ignacio
          await enviarEmailAvisoImpago({
            to: email,
            subject: 'Suscripción cancelada por impago',
            body: plantillaImpago(3, name || email, updateUrl)
          });
          await enviarEmailAvisoImpago({
            to: 'laboroteca@gmail.com',
            subject: '🔔 [Laboroteca] Suscripción cancelada por impago',
            body: `El usuario ${email} (${name}) ha sido dado de baja tras 3 intentos de cobro fallidos.`
          });
          console.log(`🚫 Suscripción cancelada y avisos enviados (${email})`);
        } catch (err) {
          console.error('❌ Error cancelando suscripción en Stripe/desactivando membresía:', err);
        }
      }
    }
    return { impago: true, fallos };
  }

  // === 3) BAJA - CANCELACIÓN DE SUSCRIPCIÓN CLUB ===
  if (eventType === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerEmail = subscription?.metadata?.email || subscription?.customer_email || '';

    console.log(`🛑 Suscripción cancelada para email: ${customerEmail}`);

    // Solo si es el Club Laboroteca
    if (
      (subscription?.metadata?.nombreProducto === 'El Club Laboroteca') ||
      ((subscription?.items?.data?.[0]?.description || '').includes('Club Laboroteca'))
    ) {
      try {
        const productId = MEMBERPRESS_IDS['El Club Laboroteca'];
        if (productId && customerEmail) {
          await syncMemberpressClub({
            email: customerEmail,
            accion: 'desactivar',
            membership_id: productId
          });
          console.log(`🚫 Baja Club Laboroteca también en MemberPress (${productId})`);
        }

        await desactivarMembresiaClub(customerEmail);
        console.log(`✅ Membresía del Club desactivada para ${customerEmail}`);
      } catch (err) {
        console.error('❌ Error al desactivar membresía del Club:', err);
      }
    }

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
