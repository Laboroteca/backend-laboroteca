// scripts/run-cron.js
const crypto = require('crypto');

(async () => {
  const u   = process.env.CRON_TARGET_URL;
  const key = process.env.MKT_CRON_KEY;
  const sec = process.env.MKT_CRON_HMAC_SECRET;
  if (!u || !key || !sec) {
    console.error('Faltan CRON_TARGET_URL / MKT_CRON_KEY / MKT_CRON_HMAC_SECRET');
    process.exit(1);
  }
  const body = JSON.stringify({});
  const ts = Date.now();
  const url = new URL(u);
  const path = url.pathname.replace(/\/{2,}/g,'/').replace(/(.)\/$/,'$1');
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');
  const base = [String(ts),'POST',path,bodySha].join('.');
  const sig  = crypto.createHmac('sha256', sec).update(base).digest('hex');

  const res = await fetch(u, {
    method: 'POST',
    headers: {
      'content-type':'application/json',
      'x-cron-key': key,
      'x-cron-ts' : String(ts),
      'x-cron-sig': sig
    },
    body
  });

  const text = await res.text();
  console.log('HTTP', res.status, text.slice(0,400));
  if (!res.ok) process.exit(1);
})();
