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
const { desactivarMembresiaClub } = require('./desactivarMembresiaClub');
const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/suscripcion mensual a el club laboroteca.*$/i, 'club laboroteca')
    .replace(/suscripcion mensual al club laboroteca.*$/i, 'club laboroteca')
    .replace(/el club laboroteca.*$/i, 'club laboroteca')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'test diario club laboroteca': 10663,
  'de cara a la jubilacion': 7994
};

async function handleStripeEvent(event) {
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const email = (
      invoice.customer_email ||
      invoice.customer_details?.email ||
      invoice.subscription_details?.metadata?.email ||
      invoice.metadata?.email
    )?.toLowerCase().trim();

    const invoiceId = invoice.id;
    const intento = invoice.attempt_count || 1;
    const enlacePago = 'https://www.laboroteca.es/gestion-pago-club/';

    const paymentIntentId = invoice.payment_intent;
    
    if (!paymentIntentId) {
      console.warn(`⚠️ [IMPAGO] payment_intent ausente para ${invoiceId}, no se puede deduplicar`);
      return { ignored: true };
    }

    const docRefIntento = firestore.collection('intentosImpago').doc(paymentIntentId);
    const docSnapIntento = await docRefIntento.get();
    if (docSnapIntento.exists) {
      console.warn(`⛔️ [IMPAGO] Evento duplicado ignorado: ${paymentIntentId}`);
      return { received: true, duplicate: true };
    }

    // Registrar el intento fallido si no es duplicado
    await docRefIntento.set({
     invoiceId,
     intento,
     email,
     timestamp: Date.now()
    });


    let nombre = invoice.customer_details?.name || '';

    if (!nombre && email) {
      try {
        const docSnap = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
        if (docSnap.exists) {
          const doc = docSnap.data();
          nombre = doc.nombre || '';
          console.log(`✅ Nombre recuperado para ${email}: ${nombre}`);
        } else {
          console.warn(`⚠️ No se encontró nombre en Firestore para ${email}`);
        }
      } catch (err) {
        console.error('❌ Error al recuperar nombre desde Firestore:', err.message);
      }
    }

    if (email && intento >= 1 && intento <= 3) {
      try {
        console.log(`⚠️ Intento de cobro fallido (${intento}) para: ${email} – ${nombre}`);

        await enviarAvisoImpago(email, nombre, intento, enlacePago, false);

        if (intento === 3) {
          await enviarAvisoImpago(email, nombre, intento, enlacePago, true);
          await desactivarMembresiaClub(email);
          await registrarBajaClub({ email, motivo: 'impago' });
        }

        await docRefIntento.set({
          invoiceId,
          intento,
          email,
          nombre,
          fecha: new Date().toISOString()
        });
      } catch (err) {
        console.error('❌ Error al enviar aviso de impago:', err?.message);
      }
    } else {
      console.warn('⚠️ Email no válido o intento fuera de rango');
    }

    return { warning: true };
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const invoiceId = invoice.id;

    const docRefFactura = firestore.collection('facturasGeneradas').doc(invoiceId);
    const docSnapFactura = await docRefFactura.get();
    if (docSnapFactura.exists) {
      console.log(`⚠️ Factura ${invoiceId} ya procesada, omitiendo duplicado.`);
      return { ignored: true };
    }

    const email = (
      invoice.customer_email ||
      invoice.customer_details?.email ||
      invoice.subscription_details?.metadata?.email ||
      invoice.metadata?.email
    )?.toLowerCase().trim();

    const importe = parseFloat((invoice.amount_paid / 100).toFixed(2));
    const lineas = invoice.lines?.data || [];

    console.log('📥 Evento invoice.paid recibido');
    console.log('📧 Email:', email);
    console.log('🧾 Líneas:', JSON.stringify(lineas, null, 2));

    const productoClub = lineas.find(line => {
      const desc = (line.description || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return desc.includes('club laboroteca') || desc.includes('suscripcion mensual');
    });

    if (email && productoClub) {
      try {
        console.log('💰 Renovación pagada - Club Laboroteca:', email, '-', importe, '€');

        let datosCliente = {
          nombre: '',
          apellidos: '',
          dni: '',
          email,
          direccion: '',
          ciudad: '',
          provincia: '',
          cp: '',
          importe,
          tipoProducto: 'Renovación Club',
          nombreProducto: 'el club laboroteca',
          descripcionProducto: 'Suscripción mensual al Club Laboroteca',
          producto: 'club laboroteca'
        };

        try {
          const docSnap = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
          if (docSnap.exists) {
            const doc = docSnap.data();
            datosCliente = {
              ...datosCliente,
              nombre: doc.nombre || datosCliente.nombre || '',
              apellidos: doc.apellidos || datosCliente.apellidos || '',
              dni: doc.dni || datosCliente.dni || '',
              direccion: doc.direccion || datosCliente.direccion || '',
              ciudad: doc.ciudad || datosCliente.ciudad || '',
              provincia: doc.provincia || datosCliente.provincia || '',
              cp: doc.cp || datosCliente.cp || ''
            };
            console.log('✅ Datos fiscales recuperados desde datosFiscalesPorEmail');
          } else {
            console.warn('⚠️ No se encontraron datos fiscales para este email');
          }
        } catch (err) {
          console.error('❌ Error buscando en datosFiscalesPorEmail:', err.message);
        }

        await guardarEnGoogleSheets(datosCliente);
        const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
        const nombreArchivo = `facturas/${email}/${Date.now()}-club-renovacion.pdf`;

        await subirFactura(nombreArchivo, pdfBuffer, {
          email,
          nombreProducto: 'el club laboroteca',
          tipoProducto: 'Renovación Club',
          importe
        });

        await enviarFacturaPorEmail(datosCliente, pdfBuffer);
        await docRefFactura.set({ procesada: true, fecha: new Date().toISOString() });

        await syncMemberpressClub({ email, accion: 'activar', membership_id: 10663, importe });
        await activarMembresiaClub(email);

      } catch (err) {
        console.error('❌ Error en factura de renovación:', err?.message);
      }
    }

    return { success: true, renovacion: true };
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const email = (
      subscription.metadata?.email ||
      subscription.customer_email ||
      subscription.customer_details?.email
    )?.toLowerCase().trim();

    const nombre = subscription.customer_details?.name || '';
    const enlacePago = 'https://www.laboroteca.es/gestion-pago-club/';

    if (email) {
      try {
        console.log('❌ Suscripción cancelada por impago:', email);
        await desactivarMembresiaClub(email);
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
    const productoSlug = amountTotal === 499 ? 'el club laboroteca' : normalizarProducto(rawNombreProducto);
    const memberpressId = MEMBERPRESS_IDS[productoSlug];

    const descripcionProducto = m.descripcionProducto || rawNombreProducto || 'Producto Laboroteca';
    const productoNormalizado = normalizarProducto(descripcionProducto);

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

      await firestore.collection('datosFiscalesPorEmail').doc(email).set(datosCliente, { merge: true });

      if (memberpressId === 10663) {
        await syncMemberpressClub({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
        await activarMembresiaClub(email);
      }

      if (memberpressId === 7994) {
        await syncMemberpressLibro({ email, accion: 'activar', membership_id: memberpressId, importe: datosCliente.importe });
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
