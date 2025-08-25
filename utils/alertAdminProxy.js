let _mod = null;
let _tried = false;

function load() {
  if (_tried) return _mod;
  _tried = true;
  try { _mod = require('./alertAdmin'); } catch { _mod = null; }
  return _mod;
}

async function alertAdminProxy(msg, meta = {}) {
  const m = load();
  if (m && typeof m.alertAdmin === 'function') {
    return m.alertAdmin(msg, meta);
  }
  console.warn('⚠️ alertAdmin (proxy fallback):', msg, meta);
}

module.exports = { alertAdminProxy };
