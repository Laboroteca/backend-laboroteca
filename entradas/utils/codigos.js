// /entradas/utils/codigos.js

/**
 * Genera un código único con formato personalizado para una entrada.
 * Ejemplo: JUB-XY123
 * @param {string} slugEvento - slug del evento (ej. "jub-2025")
 * @returns {string} Código de entrada
 */
function generarCodigoEntrada(slugEvento = '') {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const random = () =>
    letras[Math.floor(Math.random() * letras.length)] +
    letras[Math.floor(Math.random() * letras.length)] +
    Math.floor(100 + Math.random() * 900); // 100-999

  const prefijo = slugEvento.toUpperCase().slice(0, 3).replace(/[^A-Z0-9]/g, '');
  if (!prefijo) {
    alertOnce('codigos.prefijo_vacio', {
      area: 'entradas.codigos.prefijo_vacio',
      err: new Error('Prefijo vacío al generar código de entrada'),
      meta: { slugEvento }
    });
  }
  return `${prefijo}-${random()}`;
}

const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// Evita spam de alertas repetidas en este proceso
const __onceKeys = new Set();
function alertOnce(key, payload) {
  if (__onceKeys.has(key)) return;
  __onceKeys.add(key);
  try { alertAdmin(payload); } catch (_) {}
}

/**
 * Normaliza un texto para usarlo como slug: quita tildes, pasa a minúsculas,
 * elimina símbolos raros y convierte espacios en guiones.
 * @param {string} texto
 * @returns {string}
 */
function normalizar(texto) {
  if (typeof texto !== 'string') {
    alertOnce('codigos.normalizar.no_string', {
      area: 'entradas.codigos.normalizar.no_string',
      err: new Error('normalizar() recibió un valor no-string'),
      meta: { tipo: typeof texto }
    });
  }
  return (texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '');
}

module.exports = {
  generarCodigoEntrada,
  normalizar
};
