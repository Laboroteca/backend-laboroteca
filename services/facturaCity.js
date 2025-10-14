// services/facturaCity.js
// 
const axios = require('axios');
const qs = require('qs');
require('dotenv').config();
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
const crypto = require('crypto');

const FACTURACITY_API_KEY = process.env.FACTURACITY_API_KEY?.trim().replace(/"/g, '');
const API_BASE = process.env.FACTURACITY_API_URL;

function obtenerFechaHoy() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

const { ensureOnce } = require('../utils/dedupe');

const AXIOS_TIMEOUT = 10000; // 10s razonable
const fcHeaders = {
  Token: FACTURACITY_API_KEY,
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'application/json'
};

// Helpers PII-safe (mismo criterio que procesarCompra)
const hash12 = e => crypto.createHash('sha256').update(String(e || '').toLowerCase()).digest('hex').slice(0,12);
const redact = (v) => (process.env.NODE_ENV === 'production' ? hash12(String(v || '')) : String(v || ''));
const redactEmail = (e) => redact((e || '').toLowerCase().trim());

// ——— Reintentos acotados (backoff exponencial suave) solo en errores transitorios ———
function isRetryable(err) {
  const s = err?.response?.status;
  if (s && (s === 429 || (s >= 500 && s <= 599))) return true;
  const code = err?.code || '';
  return /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(code);
}
async function retry(fn, { tries = 3, baseMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || i === tries - 1) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ───────── Firestore (registro de facturas) ─────────
const admin = require('../firebase');
const firestore = admin.firestore();

function pickNumeroFactura(doc) {
  return (
    doc?.numfactura ||
    doc?.numero ||
    doc?.numFactura ||
    doc?.codigo ||
    doc?.codigoFactura ||
    null
  );
}

function pickFechaFactura(doc) {
  // intenta extraer fecha de la respuesta de FacturaCity; si no, usa "hoy"
  const raw = doc?.fechafactura || doc?.fecha || null;
  if (typeof raw === 'string') {
    // admite "dd/mm/aaaa" o "aaaa-mm-dd" o "dd-mm-aaaa"
    const m1 = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m1) {
      const [_, dd, mm, yyyy] = m1;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
    const m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) {
      const [_, yyyy, mm, dd] = m2;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
    const m3 = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m3) {
      const [_, dd, mm, yyyy] = m3;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
  }
  // fallback: hoy
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  return { iso: hoy.toISOString(), texto: `${dd}/${mm}/${yyyy}` };
}

async function registrarFacturaEnFirestore(payload) {
  try {
    // ── ID del documento robusto ──
    const docId =
      payload.invoiceId
        ? `inv_${payload.invoiceId}`
        : payload.idfactura
          ? `fc_${payload.idfactura}`
          : `tmp_${Date.now()}`;

    // ── Normalización de fecha ──
    const fechaObj = (payload.fechaISO && payload.fechaTexto)
      ? { iso: payload.fechaISO, texto: payload.fechaTexto }
      : pickFechaFactura(payload);

    // ── Escritura en colección 'facturas' ──
    await firestore.collection('facturas').doc(docId).set({
      // Claves fuertes
      invoiceId: payload.invoiceId || null,
      idfactura: payload.idfactura || null,
      numeroFactura: payload.numeroFactura || null,

      // Datos de control
      email: payload.email || null,
      tipo: payload.tipo || payload.tipoProducto || null, // alta/renovacion o tipo de producto
      fechaISO: fechaObj.iso,
      fechaTexto: fechaObj.texto,

      // Descripción e importes
      descripcionProducto: payload.descripcionProducto || null,
      importeTotalIVA: payload.importeTotalIVA ?? null,
      moneda: payload.moneda || 'EUR',

      // Timestamp de inserción
      insertadoEn: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.error('❌ Error al registrar factura en Firestore:', e);
    // no romper el flujo, solo loguear
  }
}


// Trunca a 4 decimales sin redondear (hacia abajo)
function trunc4(n) {
  return Math.floor(n * 10000) / 10000; // 4 decimales exactos
}

// Detecta errores de cálculo en FacturaCity para probar variantes de payload sin duplicar facturas
function isCalcError(err) {
  const msg = err?.response?.data?.message || err?.message || '';
  // Ampliamos heurística con textos típicos del backend
  return /calculat(e|ing)|calcular|pvp|precio|unitario|price|descripcion|linea|línea|referenc|producto|not\s*found|requerid/i.test(msg);
}

async function crearFacturaEnFacturaCity(datosCliente) {
  try {
// ✅ Kill-switch de duplicados FacturaCity
const dedupeId = String(
  datosCliente.invoiceId ||
  datosCliente.invoiceIdStripe ||  // ← PaymentIntent (checkout)
  datosCliente.sessionId ||        // ← fallback útil
  ''
).trim();

if (dedupeId) {
  const first = await ensureOnce('facturasGeneradas', dedupeId);
  if (!first) {
    console.warn(`🟡 Duplicado dedupeId=${dedupeId} ignorado en crearFacturaEnFacturaCity`);
    return null;
  }
}


    const maskedKey = FACTURACITY_API_KEY ? FACTURACITY_API_KEY.slice(-4).padStart(8, '•') : '(no definida)';
    console.log('🔐 API KEY utilizada (mascarada):', maskedKey);

if (!API_BASE) {
  await alertAdmin({
    area: 'facturacity_config',
    email: datosCliente?.email || '-',
    err: new Error('FACTURACITY_API_URL no está definida'),
    meta: { hasKey: !!FACTURACITY_API_KEY, apiUrl: API_BASE || null }
  });
  throw new Error('FACTURACITY_API_URL no está definida');
}
if (!FACTURACITY_API_KEY) {
  await alertAdmin({
    area: 'facturacity_config',
    email: datosCliente?.email || '-',
    err: new Error('FACTURACITY_API_KEY no está definida'),
    meta: { hasKey: !!FACTURACITY_API_KEY, apiUrl: API_BASE || null }
  });
  throw new Error('FACTURACITY_API_KEY no está definida');
}



    console.log('🌐 API URL utilizada:', API_BASE);
    if (process.env.NODE_ENV !== 'production') {
      console.log('🧾 Datos del cliente recibidos para facturar:', JSON.stringify(datosCliente, null, 2));
    } else {
      const safe = {
        email: redactEmail(datosCliente.email),
        nombre: datosCliente.nombre ? '***' : '',
        apellidos: datosCliente.apellidos ? '***' : '',
        dni: datosCliente.dni ? '***' : '',
        importe: datosCliente.importe,
        tipoProducto: datosCliente.tipoProducto || null,
        nombreProducto: datosCliente.nombreProducto || null
      };
      console.log('🧾 Datos facturación (sanitized):', safe);
    }

    // PVP CON IVA recibido
    const totalConIVA = Number.parseFloat(String(datosCliente.importe).replace(',', '.'));
    if (!totalConIVA || Number.isNaN(totalConIVA)) {
      throw new Error(`❌ El importe recibido no es válido: "${datosCliente.importe}"`);
    }

    // === Tipo de producto → IVA aplicable (y divisor) ===
    const tp = (datosCliente.tipoProducto || '').toLowerCase();
    const esLibro   = tp === 'libro' || /libro/.test(String(datosCliente.producto || datosCliente.nombreProducto || '').toLowerCase());
    const esEntrada = tp === 'entrada';
    const impuestoCode = esEntrada ? 'IVA10' : (esLibro ? 'IVA4' : 'IVA21'); // ajusta aquí si tus entradas van al 21%
    const divisorIVA   = impuestoCode === 'IVA10' ? 1.10 : (impuestoCode === 'IVA4' ? 1.04 : 1.21);
    const ivaPct       = (impuestoCode === 'IVA10') ? 10 : (impuestoCode === 'IVA4') ? 4 : 21;

    // === CALCULAR BASE IMPONIBLE TRUNCADA A 4 DECIMALES (sin redondeo) ===
    const baseTotal = trunc4(totalConIVA / divisorIVA); // Mantener 4 decimales
    console.log('💶 Base imponible (truncada):', baseTotal.toFixed(4), '→ IVA:', impuestoCode, '→ Total con IVA:', totalConIVA.toFixed(2));

    // ===== Cliente =====
    const cliente = {
      nombre: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      razonsocial: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      personafisica: '1',
      tipoidfiscal: 'NIF',
      cifnif: datosCliente.dni,
      direccion: datosCliente.direccion || 'Dirección no facilitada',
      codpostal: datosCliente.cp || '',
      ciudad: datosCliente.ciudad || '',
      provincia: datosCliente.provincia || '',
      pais: 'ES',
      email: datosCliente.email,
      regimeniva: 'General'
    };

    const clienteResp = await retry(() => axios.post(
      `${API_BASE}/clientes`,
      qs.stringify(cliente),
      { headers: fcHeaders, timeout: AXIOS_TIMEOUT }
    ));

    const codcliente =
      clienteResp.data?.data?.codcliente ||
      clienteResp.data?.doc?.codcliente ||
      clienteResp.data?.codcliente;
if (!codcliente) {
  await alertAdmin({
    area: 'facturacity_codcliente_missing',
    email: datosCliente.email,
    err: new Error('No se pudo obtener codcliente'),
    meta: { respuesta: clienteResp?.data || null, datosMin: { email: datosCliente.email, dni: datosCliente.dni } }
  });
  throw new Error('❌ No se pudo obtener codcliente');
}
    console.log(`✅ Cliente creado en FacturaCity codcliente=${codcliente} email=${redactEmail(datosCliente.email)}`);

    // 🏠 Dirección fiscal (opcional)
    try {
      const direccionFiscal = {
        codcliente,
        descripcion: `${datosCliente.nombre} ${datosCliente.apellidos}`,
        direccion: datosCliente.direccion || '',
        codpostal: datosCliente.cp || '',
        ciudad: datosCliente.ciudad || '',
        provincia: datosCliente.provincia || '',
        pais: 'España',
        nombre: datosCliente.nombre,
        apellidos: datosCliente.apellidos,
        email: datosCliente.email
      };
      await retry(() => axios.post(
        `${API_BASE}/direccionescliente`,
        qs.stringify(direccionFiscal),
        { headers: fcHeaders, timeout: AXIOS_TIMEOUT }
      ));

      console.log(`🏠 Dirección fiscal añadida para codcliente=${codcliente} email=${redactEmail(datosCliente.email)}`);
    } catch (err) {
      console.warn('⚠️ No se pudo añadir dirección fiscal (opcional):', err?.message || err);
      // Sin alertAdmin: este fallo es benigno y frecuente, no afecta al flujo
    }


    // ===== Referencia/Descripción =====
    const descripcion = datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto;
    // Preferimos una referencia explícita recibida desde procesarCompra/catálogo
    // (p.ej., "1" | "2" | "3" | "4" como en tu panel) y si no, mapeamos por tipo/nombre.
    const nombreNorm = (datosCliente.nombreProducto || '').toLowerCase().replace(/\s+/g,' ').trim();
    let referencia =
      (datosCliente.fcReferencia || datosCliente.referenciaProducto || datosCliente.referencia || '').toString().trim();
    if (!referencia) {
      if (/club laboroteca|cuota mensual club/.test(nombreNorm) || tp === 'club') referencia = '4';
      else if (/entrada/.test(nombreNorm) || tp === 'entrada') referencia = '3';
      else if (/adelanta tu jubil/.test(nombreNorm)) referencia = '2';
      else if (/de cara a la jubil/.test(nombreNorm) || tp === 'libro') referencia = '1';
      else referencia = 'OTRO001'; // fallback genérico si no hay match
    }


    // ===== Cantidad y PRECIO UNITARIO NETO (SIN IVA) =====
    // Cantidad prioriza valores explícitos (fcCantidad/cantidad), luego asistentes si es entrada.
    let cantidad = Number.isFinite(Number(datosCliente.fcCantidad)) ? Number(datosCliente.fcCantidad)
                : Number.isFinite(Number(datosCliente.cantidad))    ? Number(datosCliente.cantidad)
                : (esEntrada ? parseInt(datosCliente.totalAsistentes || '1', 10) : 1);
    if (!Number.isFinite(cantidad) || cantidad < 1) cantidad = 1;

// Neto y bruto por unidad (4 decimales, string)
    const pvpUnitarioNeto  = trunc4(baseTotal / cantidad).toFixed(4);
    const pvpUnitarioBruto = trunc4(totalConIVA / cantidad).toFixed(4);
    if (!Number.isFinite(Number(pvpUnitarioNeto)))  throw new Error('pvpUnitarioNeto no es numérico');
    if (!Number.isFinite(Number(pvpUnitarioBruto))) throw new Error('pvpUnitarioBruto no es numérico');

    // ── Variantes de línea para probar "producto predefinido" por referencia ──
    // 1) Solo referencia + cantidad → que coja precio/IVA del producto (requiere actualizaprecios a nivel cabecera)
    // 2) Referencia + cantidad + pvp NETO (por si exige precio)
    // 3) Referencia + cantidad + pvp BRUTO (algunas instalaciones lo esperan así)
    // 4) Neto + porcentaje (tu variante previa)
    // 5) Neto + codimpuesto (tu variante previa)
    const variantes = [
      // 1) Producto por referencia con auto-actualización de precio/IVA (neto)
      {
        nombre: 'REF+QTY+NETO (auto)',
        header: { actualizaprecios: 1, actualizarprecios: 1, recalcular: 1 },
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10), pvpunitario: pvpUnitarioNeto, incluyeiva: 0 }
      },
      // 2) Igual pero pasando bruto
      {
        nombre: 'REF+QTY+BRUTO (auto)',
        header: { actualizaprecios: 1, actualizarprecios: 1, recalcular: 1 },
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10), pvpunitario: pvpUnitarioBruto, incluyeiva: 1 }
      },
      // 3) Solo referencia + cantidad (algunos setups lo aceptan)
      {
        nombre: 'REF+QTY (auto sin pvp)',
        header: { actualizaprecios: 1, actualizarprecios: 1, recalcular: 1 },
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10) }
      },
      // 4) Referencia con neto y codimpuesto en cabecera (por si el server lo exige)
      {
        nombre: 'REF+QTY+NETO (header codimpuesto)',
        header: { codimpuesto: impuestoCode },
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10), pvpunitario: pvpUnitarioNeto, incluyeiva: 0 }
      },
      // 5) Fallbacks originales
      {
        nombre: 'NETO+porcentaje',
        header: {},
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10), pvpunitario: pvpUnitarioNeto, incluyeiva: 0, porcentaje: ivaPct, recargo: 0 }
      },
      {
        nombre: 'NETO+codimpuesto',
        header: { codimpuesto: impuestoCode },
        line:   { referencia, descripcion, cantidad: parseInt(cantidad,10), pvpunitario: pvpUnitarioNeto, incluyeiva: 0, codimpuesto: impuestoCode, recargo: 0 }
      }
    ];


    // ===== Cabecera factura =====
     const facturaBase = {
      codcliente,
      pagada: 1,
      fecha: obtenerFechaHoy(),
      codserie: 'A',
      // No fijamos codimpuesto por defecto: cada variante puede añadirlo en header si procede
      nombrecliente: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      cifnif: datosCliente.dni,
      direccion: datosCliente.direccion || '',
      ciudad: datosCliente.ciudad || '',
      provincia: datosCliente.provincia || '',
      codpostal: datosCliente.cp || ''
    };

    // Intento secuencial con variantes (sin crear duplicados)
    let facturaResp, lastErr;
    for (const v of variantes) {
      try {
        const factura = { ...facturaBase, ...(v.header || {}), lineas: JSON.stringify([v.line]) };
        console.log(`🧪 Intento crearFacturaCliente variante="${v.nombre}" ref=${referencia} qty=${cantidad}`);
        facturaResp = await axios.post(
          `${API_BASE}/crearFacturaCliente`,
          qs.stringify(factura),
          { headers: fcHeaders, timeout: AXIOS_TIMEOUT }
        );
        break; // éxito
      } catch (e) {
        lastErr = e;
        if (isCalcError(e)) {
          const st = e?.response?.status || '-';
          let body = e?.response?.data;
          try { body = typeof body === 'string' ? body.slice(0,300) : JSON.stringify(body).slice(0,300); } catch {}
          console.warn(`↻ Error de cálculo (${v.nombre}) [${st}] → ${body || '(sin cuerpo)'} → siguiente…`);
          continue;
        }
        throw e; // otros errores → salimos
      }
    }
    if (!facturaResp) {
      const reason = lastErr?.response?.data?.message || lastErr?.message || 'todas las variantes fallaron';
      throw new Error(`No se pudo crear la factura (${reason})`);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('📩 Respuesta crearFacturaCliente:', JSON.stringify(facturaResp.data, null, 2));
    } else {
      const resumen = {
        tieneDoc: !!facturaResp?.data?.doc,
        camposDoc: facturaResp?.data?.doc ? Object.keys(facturaResp.data.doc) : []
      };
      console.log('📩 Respuesta crearFacturaCliente (resumen):', resumen);
    }

    const idfactura = facturaResp.data?.doc?.idfactura;
    if (!idfactura) {
      await alertAdmin({
        area: 'facturacity_idfactura_missing',
        email: datosCliente.email,
        err: new Error('No se recibió idfactura'),
        meta: { respuesta: facturaResp?.data || null, email: datosCliente.email, invoiceId: datosCliente.invoiceId || null }
      });
      throw new Error('❌ No se recibió idfactura');
    }

    console.log(`✅ Factura emitida idfactura=${idfactura} invoiceId=${datosCliente.invoiceId || 'N/A'} email=${redactEmail(datosCliente.email)}`);


    // Nº de factura (legible si lo devuelve la API) y fecha
    const numeroFactura = pickNumeroFactura(facturaResp.data?.doc) || String(idfactura);
    const { iso: fechaISO, texto: fechaTexto } = pickFechaFactura(facturaResp.data?.doc);

    // Registrar en Firestore (NO BLOQUEA)
    await registrarFacturaEnFirestore({
      invoiceId: datosCliente.invoiceId || null,
      idfactura,
      numeroFactura,

      email: datosCliente.email,
      nombre: datosCliente.nombre,
      apellidos: datosCliente.apellidos,
      dni: datosCliente.dni,

      fechaISO,
      fechaTexto,

      descripcionProducto: (datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto || '').trim(),
      nombreProducto: datosCliente.nombreProducto || null,
      tipoProducto: datosCliente.tipoProducto || null,
      importeTotalIVA: Number.parseFloat(String(datosCliente.importe).replace(',', '.')),
      importeBase: Number(baseTotal.toFixed(4)),  // ya lo calculas arriba
      cantidad,                                   // ya calculada arriba
      referencia,                                 // ya calculada arriba
    });


    const pdfUrl = `${API_BASE}/exportarFacturaCliente/${idfactura}?lang=es_ES`;
    const pdfResponse = await retry(() => axios.get(
      pdfUrl,
      { headers: { Token: FACTURACITY_API_KEY }, responseType: 'arraybuffer', timeout: AXIOS_TIMEOUT }
    ));


    const pdfSize = pdfResponse.data?.length || 0;
    console.log(`📦 PDF generado (${pdfSize} bytes)`);
if (pdfSize <= 0) {
  await alertAdmin({
    area: 'facturacity_pdf_vacio',
    email: datosCliente.email,
    err: new Error('PDF vacío o nulo'),
    meta: { idfactura, numeroFactura, email: datosCliente.email, invoiceId: datosCliente.invoiceId || null }
  });
}

    return pdfResponse.data;
  } catch (error) {
  // 🔔 AVISO SIEMPRE (haya o no response)
  await alertAdmin({
    area: 'facturacity_error',
    email: datosCliente?.email || '-',
    err: error,
    meta: {
      invoiceId: datosCliente?.invoiceId || null,
      url: error?.config?.url || null,
      status: error?.response?.status || null,
      responseType: error?.response?.headers?.['content-type'] || null
    }
  });

  if (error.response) {
    console.error(`⛔ Error FacturaCity invoiceId=${datosCliente.invoiceId || 'N/A'} email=${redactEmail(datosCliente.email)}`);
    console.error('🔢 Status:', error.response.status);
    // Mostrar SIEMPRE un resumen útil del cuerpo de error (sin PII)
    try {
      const raw = error.response.data;
      if (typeof raw === 'string') {
        console.error('📦 FC error body (text):', raw.slice(0, 500));
      } else if (raw) {
        const pretty = JSON.stringify(raw);
        console.error('📦 FC error body (json):', pretty.slice(0, 500));
      } else {
        console.error('📦 FC error body vacío/indefinido');
      }
    } catch (e) {
      console.error('📦 No se pudo imprimir el cuerpo de error:', e.message);
    }
  } else {
    console.error(`⛔ Error FacturaCity sin respuesta invoiceId=${datosCliente.invoiceId || 'N/A'} email=${redactEmail(datosCliente.email)} → ${error.message}`);
  }

  
// 📝 Registrar fallo en Sheets aunque no haya factura (sin GCS)
try {
  const { guardarEnGoogleSheets } = require('./googleSheets');
  await guardarEnGoogleSheets({
    ...datosCliente,
    estadoFactura: 'ERROR',
    error: error.message
  });
  console.warn('⚠️ Fallo de facturación registrado en Sheets');
} catch (logErr) {
  console.error('⛔ No se pudo registrar el fallo en Sheets:', logErr.message);
}

throw new Error('Error al generar la factura');

}
}

module.exports = { crearFacturaEnFacturaCity };
