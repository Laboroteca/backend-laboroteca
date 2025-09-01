const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail, enviarEmailPersonalizado } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { normalizarProducto, MEMBERPRESS_IDS } = require('../utils/productos');
const { ensureOnce } = require('../utils/dedupe');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const crypto = require('crypto');
const fetch = require('node-fetch');

// === WP HMAC config ===
const WP_BASE = process.env.WP_BASE_URL || 'https://www.laboroteca.es';
const MP_API_KEY = process.env.MP_SYNC_API_KEY || process.env.MEMBERPRESS_KEY; // fallback si aún no tienes MP_SYNC_API_KEY
const MP_HMAC_SECRET = process.env.MP_SYNC_HMAC_SECRET;
const WP_PATH_LIBRO = '/wp-json/laboroteca/v1/libro-membership';
const WP_PATH_CLUB  = '/wp-json/laboroteca/v1/club-membership';

async function postWPHmac(path, payload) {
  if (!MP_API_KEY || !MP_HMAC_SECRET) {
    const msg = 'MP_SYNC_API_KEY / MP_SYNC_HMAC_SECRET ausentes';
    console.warn('[WP HMAC] ' + msg);
    throw new Error(msg);
  }
  const body = JSON.stringify(payload);
  const ts   = String(Date.now()); // MILISEGUNDOS (lo exige el mu-plugin)
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const base = `${ts}.POST.${path}.${bodyHash}`;
  const sig  = crypto.createHmac('sha256', MP_HMAC_SECRET).update(base).digest('hex');
  const res  = await fetch(`${WP_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': MP_API_KEY,
      'x-mp-ts': ts,
      'x-mp-sig': sig
    },
    body
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!res.ok) {
    const msg = `WP ${res.status}: ${text.slice(0,300)}`;
    console.error('[WP HMAC] ' + msg);
    throw new Error(msg);
  }
  return data;
}


// --- helper global ---
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}


module.exports = async function procesarCompra(datos) {
  let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  let nombreProducto = (datos.nombreProducto || 'Producto Laboroteca').trim();
  let descripcionProducto = datos.descripcionProducto || nombreProducto;
  let tipoProducto = datos.tipoProducto || 'Otro';
  let importe = parseFloat((datos.importe || '29,90').toString().replace(',', '.'));

  // 🔍 Buscar email por alias si no es válido
  if (!email.includes('@')) {
    const alias = (datos.alias || datos.userAlias || '').trim();
    if (alias) {
      try {
        const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
        if (userSnap.exists) {
          email = (userSnap.data().email || '').trim().toLowerCase();
          console.log(`📩 Email recuperado por alias (${alias}):`, email);
        }
      } catch (err) {
        console.error(`❌ Error recuperando email por alias "${alias}":`, err);
        try {
  await alertAdmin({
    area: 'procesarCompra_alias_lookup',
    email: '-',
    err,
    meta: { alias, hint: 'Fallo al recuperar email por alias' }
  });
} catch (_) {}

      }
    }
  }

    if (!email || !email.includes('@')) {
      console.error(`❌ Email inválido: "${email}"`);
      try {
  await alertAdmin({
    area: 'procesarCompra_email_invalido',
    email: email || '-',
    err: new Error('Email inválido'),
    meta: {
      nombreProducto, tipoProducto, importe,
      alias: (datos.alias || datos.userAlias || null)
    }
  });
} catch (_) {}

      return { success: false, mensaje: 'email_invalido' };
    }


    // 🛑 DEDUPLICACIÓN TEMPRANA (ATÓMICA) + logs
    const claveNormalizada = normalizarProducto(nombreProducto);

    // Clave de idempotencia priorizando IDs "fuertes"
    const dedupeKey =
      datos.invoiceId ||
      datos.sessionId ||
      datos.pedidoId ||
      // fallback conservador: para Club, una por día por email+importe
      (tipoProducto?.toLowerCase() === 'club'
        ? `club:${email}:${importe.toFixed(2)}:${new Date().toISOString().slice(0,10)}`
        : null);


    if (dedupeKey) {
      const first = await ensureOnce('comprasOnce', dedupeKey);
      if (!first) {
        console.warn(`🟡 Duplicado ignorado key=${dedupeKey}`);
        return { success: false, mensaje: 'Compra ya procesada (duplicado)' };
      }

      // 🔒 Segundo cerrojo: evita carreras simultáneas en paralelo
      const lockRef = firestore.collection('locks').doc(dedupeKey);
      try {
        await lockRef.create({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(String(e.message || ''))) {
        console.warn(`🟡 Duplicado ignorado (lock existe) key=${dedupeKey}`);
        return { success: false, mensaje: 'Compra ya procesada (duplicado)' };
      }
    console.error('❌ Error creando lock (continuo sin lock, riesgo mínimo de duplicado):', e);
    try {
  await alertAdmin({
    area: 'procesarCompra_lock_create',
    email,
    err: e,
    meta: { dedupeKey }
  });
} catch (_) {}

    // no returns aquí; seguir con el flujo
    }

    }


    // ✅ LOGS
    console.log('🧪 tipoProducto:', tipoProducto);
    console.log('🧪 nombreProducto:', nombreProducto);
    console.log('🔑 Clave normalizada para deduplicación:', claveNormalizada);


  const compraId = `compra-${Date.now()}`;
  // Ref única para idempotencia de activación (prioriza IDs “fuertes”)
  const activationRef = String(
    datos.invoiceId || datos.sessionId || datos.pedidoId || compraId
  );
  const docRef = firestore.collection('comprasProcesadas').doc(compraId);
  let compRef = null; // ← añadido para tracking por dedupeKey


  await docRef.set({
    compraId,
    estado: 'procesando',
    email,
    producto: claveNormalizada,
    dedupeKey: dedupeKey || null,
    fechaInicio: new Date().toISOString()
  });

  // Tracking estable por dedupeKey (además del doc temporal con timestamp)
    if (dedupeKey) {
      compRef = firestore.collection('comprasProcesadas').doc(dedupeKey);
      await compRef.set({
        estado: 'procesando',
        email,
        producto: claveNormalizada,
        dedupeKey,
        tipoProducto,
        importe,
        fechaInicio: new Date().toISOString()
      }, { merge: true });
    }



  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';

    const datosCliente = {
      nombre,
      apellidos,
      dni,
      importe,
      email,
      direccion,
      ciudad,
      cp,
      provincia,
      nombreProducto,
      descripcionProducto,
      tipoProducto
    };

    if (datos.invoiceId) {
      datosCliente.invoiceId = datos.invoiceId;
    }
    
    if (!nombre || !apellidos || !dni || !direccion || !ciudad || !provincia || !cp) {
      console.warn(`⚠️ [procesarCompra] Datos incompletos para factura de ${email}`);
    }

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    const membership_id = MEMBERPRESS_IDS[claveNormalizada];

if (membership_id) {
  // CLUB → llamada HMAC al mu-plugin
  try {
    console.log(`🔓 → [WP HMAC] Activando CLUB para ${email}`);
    await postWPHmac(WP_PATH_CLUB, { email, accion: 'activar', importe });
    console.log('✅ CLUB activado en WP');
  } catch (err) {
    console.error('❌ Error activando CLUB (WP HMAC):', err.message || err);
    try {
      await alertAdmin({
        area: 'club_activar_fallo',
        email,
        err,
        meta: { membership_id, importe, producto: claveNormalizada }
      });
    } catch (_) {}
  }
} else if (tipoProducto.toLowerCase() === 'libro') {
  // LIBRO → llamada HMAC al mu-plugin
  try {
    console.log(`📘 → [WP HMAC] Activando LIBRO para ${email}`);
    await postWPHmac(WP_PATH_LIBRO, { email, accion: 'activar', importe });
    console.log('✅ LIBRO activado en WP');
  } catch (err) {
    console.error('❌ Error activando LIBRO (WP HMAC):', err.message || err);
    try {
      await alertAdmin({
        area: 'libro_activar_fallo',
        email,
        err,
        meta: { importe, producto: claveNormalizada }
      });
    } catch (_) {}
  }
}

  // 📧 Email de confirmación al usuario (libro/club)
  try {
    const asunto =
      membership_id
        ? '✅ Tu acceso al Club Laboroteca ya está activo'
        : (tipoProducto.toLowerCase() === 'libro'
            ? '📘 Acceso activado: tu libro en Laboroteca'
            : `✅ Compra confirmada: ${nombreProducto}`);

    const fechaCompra = new Date().toISOString();

    const htmlConf = `
      <p>Hola ${datosCliente.nombre || ''},</p>
      <p>Tu ${membership_id ? '<strong>membresía del <em>Club Laboroteca</em></strong>' : (tipoProducto.toLowerCase() === 'libro' ? '<strong>acceso al libro</strong>' : '<strong>compra</strong>')} ha sido <strong>activada correctamente</strong>.</p>
      <p><strong>Producto:</strong> ${escapeHtml(nombreProducto)}<br>
        <strong>Descripción:</strong> ${escapeHtml(descripcionProducto)}<br>
        <strong>Importe:</strong> ${importe.toFixed(2).replace('.', ',')} €<br>
        <strong>Fecha:</strong> ${fechaCompra}</p>
      <p>Puedes acceder desde tu área de cliente:</p>
      <p><a href="https://www.laboroteca.es/mi-cuenta/">https://www.laboroteca.es/mi-cuenta/</a></p>
      <p>Gracias por confiar en Laboroteca.</p>
    `;

    const textConf =
  `Hola ${datosCliente.nombre || ''},

  Tu ${membership_id ? 'membresía del Club Laboroteca' : (tipoProducto.toLowerCase() === 'libro' ? 'acceso al libro' : 'compra')} ha sido activada correctamente.

  Producto: ${nombreProducto}
  Descripción: ${descripcionProducto}
  Importe: ${importe.toFixed(2)} €
  Fecha: ${fechaCompra}

  Acceso: https://www.laboroteca.es/mi-cuenta/

  Gracias por confiar en Laboroteca.`;

    await enviarEmailPersonalizado({
      to: email,
      subject: asunto,
      html: htmlConf,
      text: textConf
    });

    console.log('✅ Email de confirmación enviado al usuario');
  } catch (eConf) {
    console.error('❌ Error enviando email de confirmación:', eConf?.message || eConf);
    try {
      await alertAdmin({
        area: 'email_confirmacion_fallo',
        email,
        err: eConf,
        meta: { producto: claveNormalizada, tipoProducto }
      });
    } catch (_) {}

  }


    const datosFiscalesRef = firestore.collection('datosFiscalesPorEmail').doc(email);

    
// ⛔ Kill-switch de facturación
const invoicingDisabled =
  String(process.env.DISABLE_INVOICING).toLowerCase() === 'true' ||
  process.env.DISABLE_INVOICING === '1';

let pdfBuffer;
let facturaId = null;

if (invoicingDisabled) {
  console.warn('⛔ Facturación deshabilitada en procesarCompra. Saltando creación/subida/email.');

  // ✅ Registrar SIEMPRE en Google Sheets aunque no haya factura
  try {
    console.log('📝 → Registrando en Google Sheets (kill-switch activo)...');
    await guardarEnGoogleSheets({
  ...datosCliente,
  uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || '')
});

  } catch (err) {
    console.error('❌ Error en Google Sheets:', err);
    try {
      await alertAdmin({
        area: 'sheets_guardar_killswitch',
        email,
        err,
        meta: { uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || '') }
      });
    } catch (_) {}

  }

} else {
// 1) Crear factura
    try {
      console.log('🧾 → Generando factura...');
      const resFactura = await crearFacturaEnFacturaCity(datosCliente);
      pdfBuffer = resFactura?.pdfBuffer || resFactura || null;
      facturaId = resFactura?.facturaId || resFactura?.numeroFactura || null;

      if (!pdfBuffer) {
        console.warn('🟡 FacturaCity devolvió null (posible dedupe). No se sube ni se envía.');
      } else {
        console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);

        // 📝 Registrar la FACTURA en Sheets con ID fiscal si existe (SIN dedupe)
        const datosSheets = { ...datosCliente };
        if (facturaId) datosSheets.invoiceId = String(facturaId);
        datosSheets.uid = String(facturaId || datos.invoiceId || '');
        try {
          await guardarEnGoogleSheets(datosSheets);
        } catch (e) {
          console.error('❌ Error registrando FACTURA en Sheets:', e?.message || e);
        }
      }
    } catch (err) {
      console.error('❌ Error al crear factura:', err);
      pdfBuffer = null; // 👈 continuamos sin factura

      // 🔔 Aviso al admin con TODOS los datos para facturar manualmente
      try {
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ Fallo al generar factura (procesarCompra)',
          text: `Email: ${email}
    Nombre: ${nombre} ${apellidos}
    DNI: ${dni}
    Tipo: ${tipoProducto}
    Producto: ${nombreProducto}
    Descripción: ${descripcionProducto}
    Importe: ${importe.toFixed(2)} €
    Dirección: ${direccion}, ${cp} ${ciudad} (${provincia})
    InvoiceId: ${datos.invoiceId || '-'}
    Error: ${err?.message || String(err)}`,
          html: `<p><strong>Fallo al generar factura</strong></p>
                <ul>
                  <li><strong>Email:</strong> ${email}</li>
                  <li><strong>Nombre:</strong> ${escapeHtml(nombre)} ${escapeHtml(apellidos)}</li>
                  <li><strong>DNI:</strong> ${escapeHtml(dni)}</li>
                  <li><strong>Tipo:</strong> ${escapeHtml(tipoProducto)}</li>
                  <li><strong>Producto:</strong> ${escapeHtml(nombreProducto)}</li>
                  <li><strong>Descripción:</strong> ${escapeHtml(descripcionProducto)}</li>
                  <li><strong>Importe:</strong> ${importe.toFixed(2)} €</li>
                  <li><strong>Dirección:</strong> ${escapeHtml(direccion)}, ${escapeHtml(cp)} ${escapeHtml(ciudad)} (${escapeHtml(provincia)})</li>
                  <li><strong>InvoiceId:</strong> ${datos.invoiceId || '-'}</li>
                </ul>
                <p>Se continúa el flujo (membresía ya activada).</p>`
        });
      } catch (eAviso) {
        console.error('⚠️ No se pudo avisar al admin (procesarCompra):', eAviso?.message || eAviso);
      }
    }


  // 2) Subir a GCS
  try {
    if (pdfBuffer) {
      const base = (facturaId || datos.invoiceId || Date.now());
      const nombreArchivo = `facturas/${email}/${base}-${claveNormalizada}.pdf`;
      console.log('☁️ → Subiendo a GCS:', nombreArchivo);
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto,
        tipoProducto,
        importe
      });
      console.log('✅ Subido a GCS');
    }
  } catch (err) {
    console.error('❌ Error subiendo a GCS:', err);
    try {
      await alertAdmin({
        area: 'gcs_subida_factura',
        email,
        err,
        meta: {
          nombreArchivo: (() => {
            try {
              const base = (facturaId || datos.invoiceId || Date.now());
              return `facturas/${email}/${base}-${claveNormalizada}.pdf`;
            } catch { return null; }
          })(),
          facturaId: facturaId || null,
          invoiceId: datos.invoiceId || null
        }
      });
    } catch (_) {}

  }

  // 3) Enviar por email
  try {
  if (pdfBuffer) {
    console.log('📧 → Enviando email con factura...');
    const datosSheets = { ...datosCliente };
    if (facturaId) datosSheets.invoiceId = String(facturaId);
    const resultado = await enviarFacturaPorEmail(datosSheets, pdfBuffer);
      if (resultado === 'OK') {
        console.log('✅ Email enviado');
      } else {
        console.warn('⚠️ Resultado inesperado del envío de email:', resultado);
      }
    }
  } catch (err) {
    console.error('❌ Error enviando email:', err);
    try {
      await alertAdmin({
        area: 'email_factura_fallo',
        email,
        err,
        meta: { facturaId: facturaId || null, invoiceId: datos.invoiceId || null }
      });
    } catch (_) {}

  }


// 4) Registrar en Google Sheets SIEMPRE si NO hay factura (compra)
try {
if (!pdfBuffer) {
  console.log('📝 → Registrando COMPRA en Google Sheets (sin PDF)...');
  await guardarEnGoogleSheets({
    ...datosCliente,
    uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || '')
  });
}
} catch (err) {
  console.error('❌ Error registrando COMPRA en Sheets:', err?.message || err);
  try {
  await alertAdmin({
    area: 'sheets_guardar_compra_sin_pdf',
    email,
    err,
    meta: { uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || '') }
  });
} catch (_) {}

}


}

    // ✅ Guardar/actualizar datos fiscales sin borrar el documento (merge)
    try {
      console.log('🧾 Guardando/actualizando datos fiscales en Firestore (merge)');
      await datosFiscalesRef.set({
        nombre,
        apellidos,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        email,
        fecha: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error('❌ Error guardando datos fiscales en Firestore:', err.message || err);
      try {
        await alertAdmin({
          area: 'firestore_guardar_datos_fiscales',
          email,
          err,
          meta: { collection: 'datosFiscalesPorEmail', doc: email }
        });
      } catch (_) {}

    }

    // 🧾 Registro de venta en Firestore (best-effort)
try {
  await firestore.collection('ventas').add({
    email,
    tipoProducto,
    nombreProducto,
    descripcionProducto,
    importe,
    fecha: new Date().toISOString(),
    origen: 'procesarCompra',
    dedupeKey: dedupeKey || null
  });
  console.log('✅ Venta registrada en Firestore (ventas)');
} catch (eVenta) {
  console.error('❌ Error registrando venta en Firestore:', eVenta?.message || eVenta);
  try {
    await alertAdmin({
      area: 'firestore_registrar_venta',
      email,
      err: eVenta,
      meta: { collection: 'ventas', producto: claveNormalizada, tipoProducto, importe }
    });
  } catch (_) {}

}


    await docRef.update({
      estado: 'finalizado',
      facturaGenerada: !!pdfBuffer,
      fechaFin: new Date().toISOString()
    });

    if (compRef) {
      await compRef.set({
        estado: 'finalizado',
        facturaGenerada: !!pdfBuffer,
        fechaFin: new Date().toISOString()
      }, { merge: true });
    }



if (datos.invoiceId && pdfBuffer) {
  await firestore.collection('facturasGeneradas').doc(datos.invoiceId).set({
    procesada: true,
    fecha: new Date().toISOString()
  });
}

    console.log(`✅ Compra procesada con éxito para ${nombre} ${apellidos}`);
    console.timeEnd(`🕒 Compra ${email}`);
    return { success: true };

  } catch (error) {
    await docRef.update({
      estado: 'error',
      errorMsg: error?.message || error
    });
    if (compRef) {
      await compRef.set({
        estado: 'error',
        errorMsg: error?.message || String(error),
        fechaFin: new Date().toISOString()
      }, { merge: true });
    }
    console.error('❌ Error en procesarCompra:', error);
    try {
  await alertAdmin({
    area: 'procesarCompra_error_global',
    email,
    err: error,
    meta: { producto: claveNormalizada, dedupeKey: dedupeKey || null }
  });
} catch (_) {}

    return { success: false, mensaje: 'error_procesar_compra', error: String(error?.message || error) };

  }

};
