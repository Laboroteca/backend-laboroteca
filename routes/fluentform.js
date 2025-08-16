require('dotenv').config();
const crypto = require('crypto');
const { ensureOnce } = require('../utils/dedupe');
const procesarCompra = require('../services/procesarCompra');

module.exports = async function (req, res) {
  const tokenCliente = req.headers['authorization'];

  // 🔐 Verificación de token secreto
  if (!tokenCliente || tokenCliente !== process.env.FLUENTFORM_TOKEN) {
    console.warn('🚫 Token inválido recibido en /fluentform:', tokenCliente);
    return res.status(403).json({ error: 'Token inválido' });
  }

  const datos = req.body;
  console.log('📦 Datos recibidos desde FluentForms:\n', JSON.stringify(datos, null, 2));

  // 🔎 Normaliza claves
  const nombre   = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const email    = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  const dni      = datos.dni || '';
  const direccion= datos.direccion || '';
  const ciudad   = datos.ciudad || '';
  const provincia= datos.provincia || '';
  const cp       = datos.cp || '';
  const tipoProducto = (datos.tipoProducto || '').trim();
  const nombreProducto = (datos.nombreProducto || '').trim();
  const descripcionProducto = (datos.descripcionProducto || '').trim();
  const importe  = parseFloat((datos.importe || '0').toString().replace(',', '.'));

  // 🧪 Validación
  if (!email || !nombre || !tipoProducto || (!nombreProducto && !descripcionProducto) || !importe) {
    console.warn('⚠️ Campos requeridos faltantes:', {
      email, nombre, tipoProducto, nombreProducto, descripcionProducto, importe
    });
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  // 🔐 Clave idempotente persistente (usa ID propio del envío si existe)
  const naturalId = datos.submissionId || datos.entry_id || datos.ff_id || null;
  const dedupeKeyRaw = naturalId
    ? `ff:${naturalId}`
    : `ff:${email}|${nombreProducto || descripcionProducto}|${importe}|${new Date().toISOString().slice(0,10)}`;
  const dedupeKey = crypto.createHash('sha256').update(dedupeKeyRaw).digest('hex');

  // 🔁 Reserva atómica en Firestore: si ya existe, ignorar
  const first = await ensureOnce('ff_sessions', dedupeKey);
  if (!first) {
    console.warn(`⛔️ [fluentform] Duplicado ignorado: ${dedupeKeyRaw}`);
    return res.status(200).json({ ok: true, duplicate: true });
  }

  // 🧾 Simular objeto "session" (manteniendo compatibilidad) + espejo en raíz para procesarCompra
  const session = {
    customer_details: {
      email,
      name: `${nombre} ${apellidos}`.trim()
    },
    amount_total: Math.round(importe * 100),
    metadata: {
      nombre,
      apellidos,
      email,
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      tipoProducto,
      nombreProducto,
      descripcionProducto
    },
    // 👇 clave idempotente que también usa procesarCompra
    invoiceId: `ff_${dedupeKey}`,

    // 👉 Campos espejo para que procesarCompra funcione igual que antes
    email, // raíz
    nombreProducto,
    descripcionProducto,
    tipoProducto,
    importe
  };

  try {
    await procesarCompra(session);
    console.log('✅ Compra procesada correctamente desde /fluentform');
    res.status(200).json({ ok: true, mensaje: 'Compra procesada correctamente' });
  } catch (error) {
    console.error('❌ Error procesando compra desde /fluentform:', error);
    res.status(500).json({ error: 'Error al procesar la compra' });
  }
};
