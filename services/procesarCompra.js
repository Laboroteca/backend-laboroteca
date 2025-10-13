// services/procesarCompra.js
// 
const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail, enviarEmailPersonalizado } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const { normalizarProducto, resolverProducto, MEMBERPRESS_IDS, PRODUCTOS } = require('../utils/productos');
const { ensureOnce } = require('../utils/dedupe');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const crypto = require('crypto');
const fetch = require('node-fetch');
// util pequeño para rutas GCS sin PII
const hash12 = e => crypto.createHash('sha256').update(String(e || '').toLowerCase()).digest('hex').slice(0,12);


// util para redactar PII en logs (emails, etc.)
const redact = (v) => (process.env.NODE_ENV === 'production'
  ? hash12(String(v || ''))
  : String(v || ''));
const redactEmail = (e) => redact((e || '').toLowerCase().trim());

// Oculta el email dentro de claves de deduplicación cuando se loguean
const maskDedupeKey = (key, email) => {
  if (!key) return key;
  const e = (email || '').toLowerCase().trim();
  if (e && key.includes(e)) {
    const esc = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return key.replace(new RegExp(esc, 'g'), hash12(e));
  }
  return key;
};

// === WP HMAC config ===
const WP_BASE = process.env.WP_BASE_URL || 'https://www.laboroteca.es';
const MP_API_KEY = process.env.MP_SYNC_API_KEY || process.env.MEMBERPRESS_KEY; // fallback si aún no tienes MP_SYNC_API_KEY
const MP_HMAC_SECRET = process.env.MP_SYNC_HMAC_SECRET;
const WP_PATH_LIBRO = '/wp-json/laboroteca/v1/libro-membership';
const WP_PATH_CLUB  = '/wp-json/laboroteca/v1/club-membership';
// Club ID desde el catálogo (con fallbacks legacy)
const CLUB_ID = (
  (PRODUCTOS && PRODUCTOS['el-club-laboroteca'] && PRODUCTOS['el-club-laboroteca'].membership_id) ||
  (MEMBERPRESS_IDS && (MEMBERPRESS_IDS['el-club-laboroteca'] || MEMBERPRESS_IDS['el club laboroteca'])) ||
  10663
);

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
      'accept': 'application/json',
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
  // Preferir Stripe (amount_total viene en céntimos)
  const importeStripe =
    typeof datos.amount_total === 'number' ? (datos.amount_total / 100) :
    typeof datos.stripeAmountCents === 'number' ? (datos.stripeAmountCents / 100) :
    null;
  let importe = importeStripe ?? parseFloat((datos.importe || '29,90').toString().replace(',', '.'));
  if (!Number.isFinite(importe)) { console.warn('⚠️ importe NaN → 0'); importe = 0; }


  // 🧭 Resolver producto desde catálogo (metadata + fallback)
  const productoResuelto = resolverProducto({
    tipoProducto, nombreProducto, descripcionProducto, price_id: datos.price_id
  }, datos.lineItems || []);
  // Hoist para uso seguro en todo el flujo (incluido catch)
  let productoSlug = productoResuelto?.slug || null;
  // 🔍 Buscar email por alias si no es válido
  if (!email.includes('@')) {
    const alias = (datos.alias || datos.userAlias || '').trim();
    if (alias) {
      try {
        const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
        if (userSnap.exists) {
          email = (userSnap.data().email || '').trim().toLowerCase();
          console.log(`📩 Email recuperado por alias (${alias}):`, redactEmail(email));
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
      console.error(`❌ Email inválido: "${redactEmail(email)}"`);
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
    const claveNormalizada = normalizarProducto(nombreProducto, tipoProducto);

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
        console.warn(`🟡 Duplicado ignorado key=${maskDedupeKey(dedupeKey, email)}`);
        return { success: false, mensaje: 'Compra ya procesada (duplicado)' };
      }

      // 🔒 Segundo cerrojo: evita carreras simultáneas en paralelo
      const lockRef = firestore.collection('locks').doc(dedupeKey);
      try {
        await lockRef.create({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(String(e.message || ''))) {
        console.warn(`🟡 Duplicado ignorado (lock existe) key=${maskDedupeKey(dedupeKey, email)}`);
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

    if (productoResuelto) console.log('📦 Producto resuelto:', productoResuelto.slug, `(${productoResuelto.tipo})`);


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



  // Timer PII-safe (solo si vas a ejecutar el flujo principal)
  const _timer = `🕒 Compra ${redactEmail(email)}`;
  console.time(_timer);

  try {
    // ─────────────────────────────────────────────────────────
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

    // 🧾 Descripción de factura prioriza la plantilla del catálogo
    if (productoResuelto?.descripcion_factura) {
      datosCliente.descripcionProducto = productoResuelto.descripcion_factura;
    }
    // completar slug con la clave normalizada (sin redeclarar)
    productoSlug = productoSlug || claveNormalizada || null;

    if (datos.invoiceId) {
      datosCliente.invoiceId = datos.invoiceId;
    }
    
    if (!nombre || !apellidos || !dni || !direccion || !ciudad || !provincia || !cp) {
      console.warn(`⚠️ [procesarCompra] Datos incompletos para factura de ${redactEmail(email)}`);
    }

if (process.env.NODE_ENV !== 'production') {
   console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));
 } else {
   const safe = { ...datosCliente };
   safe.email = redactEmail(safe.email);
   safe.dni = safe.dni ? '***' : '';
   safe.direccion = safe.ciudad = safe.cp = safe.provincia = '***';
   console.log('📦 [procesarCompra] Datos facturación (sanitized):', safe);
 }

    // 🔐 Activación de membresía según catálogo (mantiene compatibilidad)
    const tipoEfectivo = (productoResuelto?.tipo || (tipoProducto || '')).toLowerCase();
  const membership_id =
      (productoResuelto?.membership_id != null
        ? Number(productoResuelto.membership_id)
        : (claveNormalizada ? Number(MEMBERPRESS_IDS[claveNormalizada]) : null));
    const esClub  = (tipoEfectivo === 'club') || (Number(membership_id) === Number(CLUB_ID));
    const esLibro = (tipoEfectivo === 'libro');
    // 🧾 Canonicalizar tipo para FACTURA (IVA):
    //    — Solo "libro" debe ir al 4 %. Resto (club, cursos, entradas, etc.) → 21 %.
    if (esLibro) {
      datosCliente.tipoProducto = 'libro';
      // (opcional) Anotar en descripción la base legal del 4 %
      if (!/art\.?\s*91/i.test(String(datosCliente.descripcionProducto || ''))) {
        datosCliente.descripcionProducto = `${datosCliente.descripcionProducto} — Libro digital (art. 91 LIVA, 4%)`;
      }
    } else if (esClub) {
      datosCliente.tipoProducto = 'Club';
    }

    // ✅ Regla general: si hay mapping MemberPress, activamos.
    //    ÚNICA caducidad mensual = CLUB (10663). Todo lo demás = pago único sin caducidad.
    const activarMembresia =
      Boolean(productoResuelto?.activar_membresia) || (membership_id != null);

if (activarMembresia && membership_id && esClub) {
  // CLUB → HMAC mu-plugin de Club
  try {
    console.log(`🔓 → [WP HMAC] Activando CLUB para ${redactEmail(email)}`);
 await postWPHmac(WP_PATH_CLUB, {
   email,
   accion: 'activar',
   importe,
   membership_id,           // explícito
   lifetime: true,          // sugerencia para el mu-plugin
   expires_at: null,        // “Nunca”
   duration_days: 0,        // por si el mu-plugin espera días
   producto: productoSlug   // trazabilidad
 });
    console.log('✅ CLUB activado en WP');
  } catch (err) {
    console.error('❌ Error activando CLUB (WP HMAC):', err.message || err);
    try {
      await alertAdmin({
        area: 'club_activar_fallo',
        email,
        err,
        meta: { membership_id, importe, producto: productoSlug }
      });
    } catch (_) {}
  }
} else if (activarMembresia && membership_id) {
  // 📘 CUALQUIER producto que NO sea el Club → pago único (sin caducidad)
  //    Se centraliza en el servicio genérico (nombre legacy, comportamiento genérico).
  try {
    console.log(`📘 → [MP] Activando acceso pago único para ${redactEmail(email)} (ID:${membership_id})`);
    await syncMemberpressLibro({
      email,
      accion: 'activar',
      membership_id,
      importe,
      // si en productos.js se define otro endpoint, úsalo aquí:
      apiUrl: productoResuelto?.meta?.mp_api_url || undefined,
      producto: productoSlug,
      nombre_producto: nombreProducto
    });
    console.log('✅ Acceso pago único activado en MemberPress');
  } catch (err) {
    console.error('❌ Error activando acceso pago único (MP):', err.message || err);
    try {
      await alertAdmin({
        area: 'producto_unico_activar_fallo',
        email,
        err,
        meta: { membership_id, importe, producto: productoSlug }
      });
    } catch (_) {}
  }
}

  // 📧 Email de confirmación al usuario (libro/club)
  try {
    const asunto = esClub
      ? '✅ Tu acceso al Club Laboroteca ya está activo'
      : (esLibro
          ? '📘 Acceso activado: tu libro en Laboroteca'
          : `✅ Compra confirmada: ${nombreProducto}`);

    const fechaCompra = new Date().toISOString();

    const htmlConf = `
      <p>Hola ${datosCliente.nombre || ''},</p>
      <p>Tu ${esClub ? '<strong>membresía del <em>Club Laboroteca</em></strong>' : (esLibro ? '<strong>acceso al libro</strong>' : '<strong>compra</strong>')} ha sido <strong>activada correctamente</strong>.</p>
      <p><strong>Producto:</strong> ${escapeHtml(nombreProducto)}<br>
        <strong>Descripción:</strong> ${escapeHtml(datosCliente.descripcionProducto)}<br>
        <strong>Importe:</strong> ${importe.toFixed(2).replace('.', ',')} €<br>
        <strong>Fecha:</strong> ${fechaCompra}</p>
      <p>Puedes acceder desde tu área de cliente:</p>
      <p><a href="https://www.laboroteca.es/mi-cuenta/">https://www.laboroteca.es/mi-cuenta/</a></p>
      <p>Gracias por confiar en Laboroteca.</p>
    `;

    const textConf =
  `Hola ${datosCliente.nombre || ''},

  Tu ${esClub ? 'membresía del Club Laboroteca' : (esLibro ? 'acceso al libro' : 'compra')} ha sido activada correctamente.

  Producto: ${nombreProducto}
  Descripción: ${datosCliente.descripcionProducto}
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
      uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || compraId),
      productoSlug
});

  } catch (err) {
    console.error('❌ Error en Google Sheets:', err);
    try {
      await alertAdmin({
        area: 'sheets_guardar_killswitch',
        email,
        err,
        meta: { uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || compraId) }
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
        datosSheets.productoSlug = productoSlug;
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
    Descripción: ${datosCliente.descripcionProducto}
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
                  <li><strong>Descripción:</strong> ${escapeHtml(datosCliente.descripcionProducto)}</li>
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
      const carpeta = (productoResuelto?.meta?.gcs_folder) || `facturas/${hash12(email)}`;
      const nombreArchivo = `${carpeta}/${base}-${(productoResuelto?.slug || claveNormalizada || 'producto')}.pdf`;
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
              const carpeta = (productoResuelto?.meta?.gcs_folder) || `facturas/${hash12(email)}`;
              return `${carpeta}/${base}-${(productoResuelto?.slug || claveNormalizada || 'producto')}.pdf`;
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
    datosSheets.productoSlug = productoSlug;
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
    uid: String(datos.invoiceId || datos.sessionId || datos.pedidoId || ''),
    productoSlug
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
    dedupeKey: dedupeKey || null,
    productoSlug
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

    console.log(`✅ Compra procesada con éxito para ${redactEmail(email)} (${nombre} ${apellidos})`);
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
    meta: { producto: productoSlug || claveNormalizada, dedupeKey: dedupeKey || null }
  });
} catch (_) {}

    return { success: false, mensaje: 'error_procesar_compra', error: String(error?.message || error) };
  } finally {
    // Cierra siempre el timer, pase lo que pase
    try { console.timeEnd(_timer); } catch {}
  }

};
