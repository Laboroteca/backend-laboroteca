/**
 * utils/riskActions.js — SOLO emails (usuario + admin)
 * - sendUserNotice(email, { idemKey }?)
 * - sendAdminAlert(userId, email, risk?, { idemKey }?)
 * Incluye: firma "Laboroteca", pie RGPD, cooldown e Idempotency-Key.
 */
'use strict';

const fetch = require('node-fetch');

const SMTP2GO_API_KEY    = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL    = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME  = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();

const ADMIN_EMAIL        = String(process.env.ADMIN_EMAIL || 'laboroteca@gmail.com').trim();
const USER_RESET_URL     = (process.env.USER_RESET_URL || 'https://www.laboroteca.es/recuperar-contrasena').replace(/\/+$/,'');

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

// Antispam
const USER_MAIL_COOLDOWN_MIN  = Number(process.env.USER_MAIL_COOLDOWN_MIN  || 1440); // 24h
const ADMIN_MAIL_COOLDOWN_MIN = Number(process.env.ADMIN_MAIL_COOLDOWN_MIN || 120);  // 2h
const IDEMPOTENCY_SHORT_WINDOW_MS = Number(process.env.IDEMPOTENCY_SHORT_WINDOW_MS || 5 * 60 * 1000);

const lastUserMail  = new Map();   // email -> ts
const lastAdminMail = new Map();   // userId -> ts
const recentIdem    = new Map();   // idemKey -> ts

const PIE_HTML = `
<hr style="margin-top:40px;margin-bottom:10px;" />
<div style="font-size:12px;color:#777;line-height:1.5;">
  En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
  Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
  Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad: <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener">https://www.laboroteca.es/politica-de-privacidad/</a>.
</div>
`.trim();

const PIE_TEXT = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).

Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.

Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a: laboroteca@gmail.com.
También puede presentar una reclamación ante la autoridad de control competente.
Más información: https://www.laboroteca.es/politica-de-privacidad/
`.trim();

function now(){ return Date.now(); }
function minutes(ms){ return ms * 60 * 1000; }
function underCooldown(map, key, mins){ return (now() - (map.get(key)||0)) < minutes(mins); }
function stamp(map, key){ map.set(key, now()); }
function skipByIdem(key){
  if (!key) return false;
  const last = recentIdem.get(key) || 0;
  if (now() - last < IDEMPOTENCY_SHORT_WINDOW_MS) return true;
  recentIdem.set(key, now());
  return false;
}

function abortPair(ms=10000){
  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function sendMail({ to, subject, text, html }){
  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL) {
    return { ok:false, status:500, data:{ error:'smtp_not_configured' } };
  }

  const SIGN_HTML = `<p style="margin-top:20px;">Un saludo,<br/> <strong>Laboroteca</strong></p>`;
  const SIGN_TEXT = `\n\nUn saludo,\nLaboroteca`;

  const htmlFinal = (html || '') + SIGN_HTML + '\n' + PIE_HTML;
  const textFinal = (text || '') + SIGN_TEXT + '\n\n' + PIE_TEXT;

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: Array.isArray(to) ? to : [to],
    sender: `${SMTP2GO_FROM_NAME} <${SMTP2GO_FROM_EMAIL}>`,
    subject,
    html_body: htmlFinal,
    text_body: textFinal
  };

  const { controller, timer } = abortPair(10000);
  try {
    const r = await fetch(SMTP2GO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await r.json().catch(()=> ({}));
    const ok = r.ok && data?.data?.succeeded === 1 && data?.data?.failed === 0;
    return { ok, status: r.status, data: ok ? {} : { error: data?.data?.error || data?.error || `status_${r.status}` } };
  } catch (e) {
    return { ok:false, status: e?.name === 'AbortError' ? 504 : 500, data:{ error: e?.message || String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

/** Email al USUARIO (con cooldown + idemKey) */
async function sendUserNotice(email, { idemKey } = {}){
  if (!email || !email.includes('@')) return { ok:false, status:400, data:{ error:'invalid_email' } };
  if (skipByIdem(idemKey)) { if (LAB_DEBUG) console.log('[userMail] skip idem', idemKey); return { ok:true, status:200, data:{ skipped:'idempotent' } }; }
  if (underCooldown(lastUserMail, email, USER_MAIL_COOLDOWN_MIN)) {
    if (LAB_DEBUG) console.log('[userMail] skip cooldown', email);
    return { ok:true, status:200, data:{ skipped:'cooldown' } };
  }

  const subject = 'Seguridad de tu cuenta — actividad inusual detectada';

  const text = `Hemos detectado actividad inusual en tu cuenta (accesos desde varias direcciones IP o navegadores).
Te recomendamos cambiar tu contraseña.
Puedes cambiarla aquí: ${USER_RESET_URL}
Si no has sido tú, puedes contactarnos a través del buzón de incidencias:
https://www.laboroteca.es/incidencias/
Recuerda que los términos y condiciones de los productos vendidos en Laboroteca, no permiten compartir cuentas, siendo posible la suspensión de la cuenta en caso de incumplimiento sin derecho a reembolso.
Equipo Laboroteca`;

  const html = `
<p>Hemos detectado <strong>actividad inusual</strong> en tu cuenta (accesos desde varias direcciones IP o navegadores).</p>
<p><strong>Te recomendamos cambiar tu contraseña.</strong></p>
<p><a href="${USER_RESET_URL}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, puedes contactarnos a través del <a href="https://www.laboroteca.es/incidencias/" target="_blank" rel="noopener noreferrer">buzón de incidencias</a>.</p>
<p style="margin-top:14px;">Recuerda que los <strong>Términos y Condiciones</strong> de los productos vendidos en Laboroteca no permiten compartir cuentas, siendo posible la suspensión de la cuenta en caso de incumplimiento sin derecho a reembolso.</p>
<p><em>Equipo Laboroteca</em></p>
`.trim();

  const resp = await sendMail({ to: email, subject, text, html });
  if (resp.ok) stamp(lastUserMail, email);
  return resp;
}

/** Email al ADMIN (con cooldown + idemKey) */
async function sendAdminAlert(userId, email, risk=null, { idemKey } = {}){
  const uid = String(userId || '').trim();
  if (!uid) return { ok:false, status:400, data:{ error:'invalid_userId' } };
  if (!ADMIN_EMAIL) return { ok:false, status:500, data:{ error:'admin_email_not_configured' } };

  if (skipByIdem(idemKey)) { if (LAB_DEBUG) console.log('[adminMail] skip idem', idemKey); return { ok:true, status:200, data:{ skipped:'idempotent' } }; }
  if (underCooldown(lastAdminMail, uid, ADMIN_MAIL_COOLDOWN_MIN)) {
    if (LAB_DEBUG) console.log('[adminMail] skip cooldown', uid);
    return { ok:true, status:200, data:{ skipped:'cooldown' } };
  }

  const subject = `🚨 Actividad inusual — userId=${uid}`;
  const reasons = Array.isArray(risk?.reasons) ? risk.reasons.join(', ') : '—';
  const ip24 = risk?.metrics?.ip24 ?? 'n/a';
  const ua24 = risk?.metrics?.ua24 ?? 'n/a';
  const log15 = risk?.metrics?.logins15 ?? 'n/a';
  const geoKmh = risk?.metrics?.geoKmh ?? 'n/a';

  const text =
`Se ha detectado actividad inusual.

Usuario: ${uid}${email ? ` · ${email}` : ''}
Motivo: ${reasons}

Métricas:
- IPs (24h): ${ip24}
- UAs (24h): ${ua24}
- Logins (15m): ${log15}
- Geo (km/h): ${geoKmh}`;

  const html =
`<h2>🚨 Actividad inusual</h2>
<p><strong>Usuario:</strong> ${uid}${email ? ` · ${email}` : ''}</p>
<p><strong>Motivo:</strong> ${reasons}</p>
<ul>
  <li>IPs (24h): <strong>${ip24}</strong></li>
  <li>UAs (24h): <strong>${ua24}</strong></li>
  <li>Logins (15m): <strong>${log15}</strong></li>
  <li>Geo (km/h): <strong>${geoKmh}</strong></li>
</ul>`;

  const resp = await sendMail({ to: ADMIN_EMAIL, subject, text, html });
  if (resp.ok) stamp(lastAdminMail, uid);
  return resp;
}

module.exports = {
  sendUserNotice,
  sendAdminAlert
};
