async function closeAllSessionsWP(userId){
  const endpoint = process.env.WP_RISK_ENDPOINT;
  const secret   = process.env.WP_RISK_SECRET;
  if (!endpoint || !secret) return;
  const ts  = Math.floor(Date.now()/1000);
  const sig = hmac(secret, `${userId}.${ts}`);

  const { default: fetch } = await import('node-fetch');
  const { default: AbortController } = await import('abort-controller');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ts, sig }),
      signal: ctl.signal
    });
  } finally { clearTimeout(timer); }
}
