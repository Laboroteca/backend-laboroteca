require('dotenv').config();
const procesarCompra = require('../services/procesarCompra');

const processedSessions = new Set(); // ⛔️ Evita duplicados

module.exports = async function (req, res) {
  const tokenCliente = req.headers['authorization'];

  // 🔐 Verificación de token secreto
  if (!tokenCliente || tokenCliente !== process.env.FLUENTFORM_TOKEN) {
    console.warn('🚫 Token inválido recibido en /fluentform:', tokenCliente);
    return res.status(403).json({ error: 'Token inválido' });
  }

  const datos = req.body;
  console.log('📦 Datos recibidos desde FluentForms:\n', JSON.stringify(datos, null, 2));
  const { procesarRegistroPendiente } = require('../services/procesarRegistroPendiente');
  const { enviarEmailActivacion } = require('../services/email');

  // Si es formulario de tipo 'registro', gestionar cuenta pendiente
  if (datos.tipoFormulario === 'registro') {
    try {
      const resultado = await procesarRegistroPendiente(datos);
      if (resultado) {
        await enviarEmailActivacion(resultado.email, resultado.token, resultado.nombre);
        return res.status(200).json({ ok: true, mensaje: 'Registro pendiente. Revisa tu email para activarlo.' });
      }
    } catch (error) {
      console.error('❌ Error al procesar el registro pendiente:', error);
      return res.status(500).json({ error: 'Error registrando usuario pendiente.' });
    }
  }


  // 🔎 Normaliza claves
  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const email = datos.email_autorelleno || datos.email || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';
  const descripcionProducto = datos.descripcionProducto || '';
  const importe = parseFloat((datos.importe || '0').toString().replace(',', '.'));

  // 🧪 Validación
  if (!email || !nombre || !tipoProducto || (!nombreProducto && !descripcionProducto) || !importe) {
    console.warn('⚠️ Campos requeridos faltantes:', {
      email, nombre, tipoProducto, nombreProducto, descripcionProducto, importe
    });
    return res.status(400).json({ error: 'Faltan datos requeridos.' });
  }

  // 🧾 Simular objeto "session" de Stripe
  const sessionId = `${email}-${nombreProducto || descripcionProducto}-${importe}`;
  if (processedSessions.has(sessionId)) {
    console.warn(`⚠️ Sesión ya procesada: ${sessionId}`);
    return res.status(200).json({ ok: true, mensaje: 'Duplicado ignorado' });
  }
  processedSessions.add(sessionId);

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
    }
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
