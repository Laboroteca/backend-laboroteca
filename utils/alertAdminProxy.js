// utils/alertAdminProxy.js
'use strict';

let _mod = null;
let _tried = false;

function load() {
  if (_tried) return _mod;
  _tried = true;
  try {
    // Puede exportar default o named
    const m = require('./alertAdmin');
    _mod = m && typeof m === 'function' ? { alertAdmin: m } : m;
  } catch (e) {
    _mod = null;
  }
  return _mod;
}

const maskEmail = (e = '') => {
  const [u, d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@***${d.slice(-3)}`;
};

/**
 * Acepta:
 *  alertAdminProxy('mensaje', { area, email, err, meta })
 *  alertAdminProxy({ area, email, err|error|message, meta })
 */
async function alertAdminProxy(arg, maybeMeta = {}) {
  const payload =
    arg && typeof arg === 'object' && !Array.isArray(arg)
      ? arg
      : { message: String(arg || ''), ...(maybeMeta || {}) };

  const m = load();
  if (m && typeof m.alertAdmin === 'function') {
    // Unificamos en un solo objeto en toda la app
    return m.alertAdmin(payload);
  }

  // Fallback sin PII: no volcar objetos completos
  try {
    const area = payload.area || 'generic';
    const email = payload.email ? maskEmail(payload.email) : '-';
    const msg =
      (payload.err && payload.err.message) ||
      payload.message ||
      (payload.error && payload.error.message) ||
      '';
    console.warn(`⚠️ alertAdmin (proxy fallback) area=${area} email=${email} msg=${msg}`);
  } catch {
    console.warn('⚠️ alertAdmin (proxy fallback)');
  }
}

// Compat: export default y named
module.exports = alertAdminProxy;
module.exports.alertAdminProxy = alertAdminProxy;
