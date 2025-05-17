require('dotenv').config();

module.exports = async function (req, res) {
  const tokenCliente = req.headers['authorization'];

  if (tokenCliente !== process.env.FLUENTFORM_TOKEN) {
    console.warn('🚫 Token inválido recibido en /fluentform');
    return res.status(403).json({ error: 'Token inválido' });
  }

  const datos = req.body;

  console.log('📦 Datos recibidos del formulario FluentForms:', datos);

  // Aquí puedes llamar a procesarCompra(datos) si ya tienes esa función exportada,
  // o bien copiar la lógica directamente aquí.
  res.status(200).json({ ok: true, mensaje: 'Formulario recibido y token válido' });
};
