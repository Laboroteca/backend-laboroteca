// utils/alertAdmin.js
const crypto = require('crypto');
const { enviarEmailPersonalizado } = require('../services/email');
const { ensureOnce } = require('./dedupe');

const ADMIN_EMAIL = process.env.ADMIN_ALERTS_TO || 'laboroteca@gmail.com';
const escapeHtml = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');
const hash12 = e => crypto.createHash('sha256').update(String(e || '').toLowerCase()).digest('hex').slice(0,12);

async function alertAdmin({ area, email, err, meta = {}, dedupeKey }) {
  try {
    const key = dedupeKey || `alert:${(area||'-').toLowerCase()}:${(email||'-').toLowerCase()}:${hash12(String(err?.message || err || '-'))}`;
    const first = await ensureOnce('adminAlerts', key);
    if (!first) return;

    const E = v => escapeHtml(String(v ?? '-'));
    const T = v => String(v ?? '-');

    const subject = `🚨 FALLO ${T(area).toUpperCase()} — ${T(email || '-')}`;
    const text = [
      `Área: ${T(area)}`,
      `Email: ${T(email || '-')}`,
      `Error: ${T(err?.message || err || '-')}`,
      `Meta: ${T(JSON.stringify(meta))}`,
      `Entorno: ${T(process.env.NODE_ENV || 'dev')}`,
      ``,
      `ℹ️ Pega este email en ChatGPT para generar un comando y solucionarlo manualmente en PowerShell.`
    ].join('\n');

    const html = `
      <h3>Fallo en ${E(area)}</h3>
      <ul>
        <li><strong>Email:</strong> ${E(email || '-')}</li>
        <li><strong>Error:</strong> ${E(err?.message || err || '-')}</li>
        <li><strong>Entorno:</strong> ${E(process.env.NODE_ENV || 'dev')}</li>
      </ul>
      <pre style="white-space:pre-wrap">${E(JSON.stringify(meta, null, 2))}</pre>
      <p style="margin-top:15px;color:#444;font-size:14px">
        ℹ️ Pega este email en ChatGPT para generar un comando y solucionarlo manualmente en PowerShell.
      </p>
    `;

    await enviarEmailPersonalizado({ to: ADMIN_EMAIL, subject, text, html });
  } catch (e) {
    console.error('⚠️ alertAdmin fallo:', e?.message || e);
  }
}

module.exports = { alertAdmin };
