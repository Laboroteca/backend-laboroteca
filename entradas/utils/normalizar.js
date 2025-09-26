/**
 * Normaliza un texto para usarlo como slug seguro:
 * - Quita tildes/acentos
 * - Minúsculas
 * - Sustituye espacios por guiones
 * - Solo [a-z0-9-]
 * @param {string} texto
 * @returns {string}
 */
function normalizar(texto) {
  if (typeof texto !== 'string') {
    try {
      const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');
      alertAdmin({
        area: 'utils.normalizar.tipo_invalido',
        email: '-',
        err: new Error('normalizar() recibió un valor no-string'),
        meta: { tipo: typeof texto }
      }).catch(() => {});
    } catch (_) {}
    return '';
  }
  return texto
    .normalize('NFD')                     // separa tildes
    .replace(/[\u0300-\u036f]/g, '')      // elimina marcas
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')                 // espacios → guiones
    .replace(/[^a-z0-9\-]/g, '');         // limpia símbolos
}

module.exports = { normalizar };
