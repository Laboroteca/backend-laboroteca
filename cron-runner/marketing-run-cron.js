// Minimal, robust HMAC runner for /marketing/cron-send
// Env needed (Railway):
//  - CRON_TARGET_URL          e.g. https://tu-backend/marketing/cron-send
//  - MKT_CRON_KEY             header x-cron-key
//  - MKT_CRON_HMAC_SECRET     HMAC secret for x-cron-sig
// Optional:
//  - CRON_BODY                JSON string (default: "{}")

const crypto = require('crypto');

async function main() {
  const u   = process.env.CRON_TARGET_URL;
  const key = process.env.MKT_CRON_KEY;
  const sec = process.env.MKT_CRON_HMAC_SECRET;
  const bodyStr = process.env.CRON_BODY && process.env.CRON_BODY.trim() ? process.env.CRON_BODY : '{}';

  if (!u || !key || !sec) {
    console.error('[cron-runner] Missing env: CRON_TARGET_URL / MKT_CRON_KEY / MKT_CRON_HMAC_SECRET');
    process.exit(2);
  }

  // Normalize path: no trailing slash (except root)
  const url  = new URL(u);
  let path   = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // sha256(body)
  let body;
  try { body = JSON.stringify(JSON.parse(bodyStr)); } catch { body = bodyStr; }
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');

  // HMAC v2 base: ts.POST.path.sha256(body)
  const tsMs = Date.now();
  const base = [String(tsMs), 'POST', path, bodySha].join('.');
  const sig  = crypto.createHmac('sha256', sec).update(base).digest('hex');

  // Prefer global fetch (Node 18+). Fallback to node-fetch if needed.
  const doFetch = global.fetch ? global.fetch : (...args) => import('node-fetch').then(m => m.default(...args));

  const res = await doFetch(u, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cron-key'  : key,
      'x-cron-ts'   : String(tsMs),
      'x-cron-sig'  : sig,
    },
    body
  });

  const text = await res.text();
  console.log('[cron-runner]', 'HTTP', res.status, '-', text.slice(0, 500));
  if (!res.ok) process.exit(1);
}

main().catch(err => {
  console.error('[cron-runner] Fatal:', err?.message || err);
  process.exit(3);
});
