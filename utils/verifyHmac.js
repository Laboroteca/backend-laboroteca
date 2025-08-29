'use strict';
const crypto = require('crypto');
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const seen = new Map();
function gcSeen(){ const now=Date.now(); for(const [k,v] of seen.entries()) if(v<now) seen.delete(k); }
function sha256str(s){ return crypto.createHash('sha256').update(s,'utf8').digest('hex'); }
function verifyHmac({ method, path, bodyRaw, headers, secret, skewMs=DEFAULT_SKEW_MS }) {
  const ts = String(headers['x-lab-ts'] || headers['X-Lab-Ts'] || '');
  const sig = String(headers['x-lab-sig'] || headers['X-Lab-Sig'] || '');
  const reqId = String(headers['x-request-id'] || headers['X-Request-Id'] || '');
  if (!ts || !sig || !reqId) return { ok:false, error:'missing_headers' };
  const now=Date.now(), tsNum=Number(ts);
  if (!Number.isFinite(tsNum)) return { ok:false, error:'bad_ts' };
  if (Math.abs(now - tsNum) > skewMs) return { ok:false, error:'skew' };
  gcSeen(); if (seen.has(reqId)) return { ok:false, error:'replay' };
  const bodyHash = sha256str(bodyRaw || '');
  const base = `${ts}.POST.${path}.${bodyHash}`;
  const expect = crypto.createHmac('sha256', secret).update(base).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return { ok:false, error:'bad_sig' };
  seen.set(reqId, now + 10 * 60 * 1000);
  return { ok:true };
}
module.exports = { verifyHmac };
