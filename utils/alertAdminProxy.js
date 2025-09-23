let _mod = null;
let _tried = false;

function load() {
  if (_tried) return _mod;
  _tried = true;
  try { _mod = require('./alertAdmin'); } catch { _mod = null; }
  return _mod;
}

const maskEmail = (e='') => {
  const [u,d] = String(e).split('@'); if(!u||!d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(-3)}`;
};

async function alertAdminProxy(arg, maybeMeta = {}) {
  // Acepta ambos formatos: (mensaje, meta) o payload por objeto { area, email, err, meta }
  const payload = (arg && typeof arg === 'object' && !Array.isArray(arg))
    ? arg
    : { message: String(arg || ''), ...(maybeMeta || {}) };

  const m = load();
  if (m && typeof m.alertAdmin === 'function') {
    // Unificamos en un solo objeto en toda la app
    return m.alertAdmin(payload);
  }

  // Fallback sin PII: no volcar objetos completos
  try {
    const area  = payload.area || 'generic';
    const email = payload.email ? maskEmail(payload.email) : '-';
    const msg   = (payload.err && payload.err.message) || payload.message || '';
    console.warn(`⚠️ alertAdmin (proxy fallback) area=${area} email=${email} msg=${msg}`);
  } catch {
    console.warn('⚠️ alertAdmin (proxy fallback)');
  }
}
