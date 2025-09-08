/**
 * utils/riskActions.js — SOLO emails (usuario + admin)
 * - sendUserNotice(email, { idemKey }?)
 * - sendAdminAlert(userId, email, risk?, { idemKey }?)
 * Seguridad producción:
 *   • Validaciones de entrada
 *   • Idempotencia corta (memoria en proceso)
 *   • Cooldown por destinatario
 *   • Cap de memoria y limpieza LRU
 *   • Reintentos con backoff en 429/5xx
 *   • Logs sin secretos (solo si LAB_DEBUG=1)
 *   • Firma + pie RGPD
 */
'use strict';

const fetch = require('node-fetch');

/* ======================== ENV & Config ======================== */
const SMTP2GO_API_KEY    = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL    = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME  = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();

const ADMIN_EMAIL        = String(process.env.ADMIN_EMAIL || 'laboroteca@gmail.com').trim();
const USER_RESET_URL     = (process.env.USER_RESET_URL || 'https://www.laboroteca.es/recuperar-contrasena').replace(/\/+$/,'');

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

/* Antispam / Idempotencia */
const USER_MAIL_COOLDOWN_MIN         = Number(process.env.USER_MAIL_COOLDOWN_MIN  || 1440); // 24h
const ADMIN_MAIL_COOLDOWN_MIN        = Number(process.env.ADMIN_MAIL_COOLDOWN_MIN || 120);  // 2h
const IDEMPOTENCY_SHORT_WINDOW_MS    = Number(process.env.IDEMPOTENCY_SHORT_WINDOW_MS || 5 * 60 * 1000);

/* Robustez envío */
const SMTP_RETRY_ATTEMPTS            = Math.max(0, Number(process.env.SMTP_RETRY_ATTEMPTS || 2));
const SMTP_RETRY_BASE_MS             = Math.max(100, Number(process.env.SMTP_RETRY_BASE_MS || 1000));
const SMTP_TIMEOUT_MS                = Math.max(3000, Number(process.env.SMTP_TIMEOUT_MS || 10000));

/* Caps memoria para evitar leaks en procesos long-lived */
const MAX_IDEMPOTENCY_KEYS           = Math.max(100, Number(process.env.MAX_IDEMPOTENCY_KEYS || 1000));
const MAX_COOLDOWN_TRACKS            = Math.max(100, Number(process.env.MAX_COOLDOWN_TRACKS || 2000));

/* ======================== Estado en memoria ======================== */
const lastUserMail  = new Map();   // email -> ts
const lastAdminMail = new Map();   // userId -> ts
const recentIdem    = new Map();   // idemKey -> ts (idempotencia corta)

/* ======================== Utilidades ======================== */
function now(){ return Date.now(); }
function minutes(min){ return min * 60 * 1000; }
function underCooldown(map, key, mins){ return (now() - (map.get(key)||0)) < minutes(mins); }
function stamp(map, key){ map.set(key, now()); ensureCapLRU(map, MAX_COOLDOWN_TRACKS); }

function skipByIdem(key){
  if (!key) return false;
  const last = recentIdem.get(key) || 0;
  if (now() - last < IDEMPOTENCY_SHORT_WINDOW_MS) return true;
  recentIdem.set(key, now());
  ensureCapLRU(recentIdem, MAX_IDEMPOTENCY_KEYS);
  return false;
}

function ensureCapLRU(map, cap){
  if (map.size <= cap) return;
  // elimina N más antiguos (N = exceso + margen)
  const excess = map.size - cap;
  const toRemove = Math.min(excess + 25, map.size);
  // map no guarda orden por acceso; guardamos por timestamp ascendente
  const arr = [];
  for (const [k,v] of map.entries()) arr.push([k,v]);
  arr.sort((a,b)=> a[1]-b[1]);
  for (let i=0; i<toRemove; i++){
    map.delete(arr[i][0]);
  }
}

function sanitizeEmail(email){
  const s = String(email||'').trim();
  // Regex razonable (no perfecta) + límites
  if (s.length < 6 || s.length > 254) return '';
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  return ok ? s : '';
}

function redact(value, keepEnd=4){
  if (!value) return '';
  const s = String(value);
  if (s.length <= keepEnd) return '*'.repeat(s.length);
  return '*'.repeat(Math.max(4, s.length - keepEnd)) + s.slice(-keepEnd);
}

function logDebug(...args){
  if (LAB_DEBUG) console.log(...args);
}

function abortPair(ms=SMTP_TIMEOUT_MS){
  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

/* ======================== Firma & Pie RGPD ======================== */
const SIGN_HTML = `<p style="margin-top:20px;">Un saludo,<br/> <strong>Laboroteca</strong></p>`;
const SIGN_TEXT = `\n\nUn saludo,\nLaboroteca`;

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

/* ======================== Envío SMTP2GO ======================== */
async function sendMail({ to, subject, text, html, idemKey }){
  // Validación de configuración
  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL || !SMTP2GO_FROM_EMAIL) {
    logDebug('[smtp2go] not_configured', {
      haveKey: !!SMTP2GO_API_KEY,
      haveUrl: !!SMTP2GO_API_URL,
      fromEmail: SMTP2GO_FROM_EMAIL
    });
    return { ok:false, status:500, data:{ error:'smtp_not_configured' } };
  }

  // Sanitización de destinatarios
  const recipients = Array.isArray(to) ? to : [to];
  const clean = recipients.map(sanitizeEmail).filter(Boolean);
  if (clean.length === 0) {
    logDebug('[smtp2go] invalid_to', { to });
    return { ok:false, status:400, data:{ error:'invalid_recipient' } };
  }

  const htmlFinal = (html || '') + SIGN_HTML + '\n' + PIE_HTML;
  const textFinal = (text || '') + SIGN_TEXT + '\n\n' + PIE_TEXT;

  // Algunos proveedores permiten custom headers; SMTP2GO acepta "custom_headers"
  const customHeaders = [];
  if (idemKey) customHeaders.push({ header: 'Idempotency-Key', value: String(idemKey).slice(0,128) });

  // Construcción del payload (sin loguear api_key)
  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: clean,
    sender: `${SMTP2GO_FROM_NAME} <${SMTP2GO_FROM_EMAIL}>`,
    subject: String(subject || '').slice(0,255),
    html_body: htmlFinal,
    text_body: textFinal,
    ...(customHeaders.length ? { custom_headers: customHeaders } : {})
  };

  // Reintentos con backoff exponencial leve
  for (let attempt = 0; attempt <= SMTP_RETRY_ATTEMPTS; attempt++){
    const { controller, timer } = abortPair(SMTP_TIMEOUT_MS);
    try {
      const r = await fetch(SMTP2GO_API_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const data = await r.json().catch(()=> ({}));
      const ok = r.ok && data?.data?.succeeded === 1 && data?.data?.failed === 0;

      logDebug('[smtp2go] resp', {
        status: r.status,
        ok,
        // No logueamos bodies largos: solo campos seguros
        safe: {
          to: clean,
          sender: `${SMTP2GO_FROM_NAME} <${SMTP2GO_FROM_EMAIL}>`,
          subject: payload.subject,
          idemKey: idemKey ? redact(idemKey) : undefined,
        },
        provider: {
          succeeded: data?.data?.succeeded,
          failed: data?.data?.failed,
          error: data?.data?.error || data?.error
        }
      });

      if (ok) return { ok:true, status:r.status, data:{} };

      // Si fallo recuperable (429 o 5xx), reintentamos
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const delay = SMTP_RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      // Fallo no recuperable → devolvemos
      return { ok:false, status:r.status, data:{ error: data?.data?.error || data?.error || `status_${r.status}` } };

    } catch (e) {
      const status = (e?.name === 'AbortError') ? 504 : 500;
      logDebug('[smtp2go] exception', { status, msg: e?.message || String(e) });
      // Reintentar solo si no hemos agotado intentos
      if (attempt < SMTP_RETRY_ATTEMPTS) {
        const delay = SMTP_RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      return { ok:false, status, data:{ error: e?.message || String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  // No debería alcanzarse
  return { ok:false, status:500, data:{ error:'unknown_send_error' } };
}

/* ======================== Emails de negocio ======================== */
/** Email al USUARIO (con cooldown + idemKey) */
async function sendUserNotice(email, { idemKey } = {}) {
  const safeEmail = sanitizeEmail(email);
  if (!safeEmail) return { ok:false, status:400, data:{ error:'invalid_email' } };

  logDebug('[userMail] called', { email: safeEmail, idemKey: idemKey ? redact(idemKey) : undefined });

  // Idempotencia corta con namespace por canal (user)
  const scopedKey = idemKey ? `user:${idemKey}` : null;
  if (skipByIdem(scopedKey)) {
    logDebug('[userMail] skip idem', { email: safeEmail });
    return { ok:true, status:200, data:{ skipped:'idempotent' } };
  }
  if (underCooldown(lastUserMail, safeEmail, USER_MAIL_COOLDOWN_MIN)) {
    logDebug('[userMail] skip cooldown', { email: safeEmail });
    return { ok:true, status:200, data:{ skipped:'cooldown' } };
  }

  const subject = 'Seguridad de tu cuenta — actividad inusual detectada';

  const text = `Hemos detectado actividad inusual en tu cuenta: accesos desde varias direcciones IP o navegadores.
Te recomendamos cambiar tu contraseña.
Puedes cambiarla aquí: ${USER_RESET_URL}
Si no has sido tú, puedes contactarnos a través del buzón de incidencias:
https://www.laboroteca.es/incidencias/
Recuerda que los términos y condiciones de los productos vendidos en Laboroteca, no permiten compartir cuentas, siendo posible la suspensión de la cuenta en caso de incumplimiento sin derecho a reembolso.
Equipo Laboroteca`;

  const html = `
<p>Hemos detectado <strong>actividad inusual en tu cuenta</strong>: accesos desde varias direcciones IP o navegadores.</p>
<p><strong>Te recomendamos cambiar tu contraseña.</strong></p>
<p><a href="${USER_RESET_URL}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, puedes contactarnos a través del <a href="https://www.laboroteca.es/incidencias/" target="_blank" rel="noopener noreferrer">buzón de incidencias</a>.</p>
<p style="margin-top:14px;">Recuerda que los <strong>Términos y Condiciones</strong> de los productos vendidos en Laboroteca no permiten compartir cuentas, siendo posible la suspensión de la cuenta en caso de incumplimiento sin derecho a reembolso.</p>
<p><em>Equipo Laboroteca</em></p>
`.trim();

  const resp = await sendMail({ to: safeEmail, subject, text, html, idemKey: scopedKey });
  if (resp.ok) stamp(lastUserMail, safeEmail);
  return resp;
}


/** Email al ADMIN (con cooldown + idemKey) */
async function sendAdminAlert(userId, email, risk=null, { idemKey } = {}){
  const uid = String(userId || '').trim();
  if (!uid) return { ok:false, status:400, data:{ error:'invalid_userId' } };
  if (!ADMIN_EMAIL) return { ok:false, status:500, data:{ error:'admin_email_not_configured' } };

  const safeEmail = sanitizeEmail(email) || undefined;

  logDebug('[adminMail] called', {
    uid,
    email: safeEmail,
    idemKey: idemKey ? redact(idemKey) : undefined
  });

  // Idempotencia corta con namespace por canal (admin)
  const scopedKey = idemKey ? `admin:${idemKey}` : null;
  if (skipByIdem(scopedKey)) {
    logDebug('[adminMail] skip idem', { uid });
    return { ok:true, status:200, data:{ skipped:'idempotent' } };
  }
  if (underCooldown(lastAdminMail, uid, ADMIN_MAIL_COOLDOWN_MIN)) {
    logDebug('[adminMail] skip cooldown', { uid });
    return { ok:true, status:200, data:{ skipped:'cooldown' } };
  }

  const subject = `🚨 Actividad inusual — userId=${uid}`;
  const reasons = Array.isArray(risk?.reasons) ? risk.reasons.join(', ') : '—';
  const ip24   = (risk && risk.metrics && risk.metrics.ip24   != null) ? risk.metrics.ip24   : 'n/a';
  const ua24   = (risk && risk.metrics && risk.metrics.ua24   != null) ? risk.metrics.ua24   : 'n/a';
  const log15  = (risk && risk.metrics && risk.metrics.logins15!= null) ? risk.metrics.logins15: 'n/a';
  const geoKmh = (risk && risk.metrics && risk.metrics.geoKmh != null) ? risk.metrics.geoKmh : 'n/a';

  const text =
`Se ha detectado actividad inusual.

Usuario: ${uid}${safeEmail ? ` · ${safeEmail}` : ''}
Motivo: ${reasons}

Métricas:
- IPs (24h): ${ip24}
- UAs (24h): ${ua24}
- Logins (15m): ${log15}
- Geo (km/h): ${geoKmh}`;

  const html =
`<h2>🚨 Actividad inusual</h2>
<p><strong>Usuario:</strong> ${uid}${safeEmail ? ` · ${safeEmail}` : ''}</p>
<p><strong>Motivo:</strong> ${reasons}</p>
<ul>
  <li>IPs (24h): <strong>${ip24}</strong></li>
  <li>UAs (24h): <strong>${ua24}</strong></li>
  <li>Logins (15m): <strong>${log15}</strong></li>
  <li>Geo (km/h): <strong>${geoKmh}</strong></li>
</ul>`;

  const resp = await sendMail({ to: ADMIN_EMAIL, subject, text, html, idemKey: scopedKey });
  if (resp.ok) stamp(lastAdminMail, uid);
  return resp;
}

module.exports = {
  sendUserNotice,
  sendAdminAlert
};
