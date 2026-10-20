'use strict';
const crypto = require('node:crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TTL = 10 * 60 * 1000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const unavailable = () => fail('Conectarea Google nu este configurată. Folosește numele de utilizator și parola.', 503);
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createGoogleAuth(options = {}) {
  const clientId = options.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = options.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
  const redirectUri = options.redirectUri ?? process.env.GOOGLE_REDIRECT_URI ?? '';
  const cookieSecret = options.cookieSecret || '';
  const secureCookies = options.secureCookies !== false;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const cookieName = secureCookies ? '__Host-nova_google_oauth' : 'nova_google_oauth';
  const cookieSuffix = '; Path=/; HttpOnly; SameSite=Lax' + (secureCookies ? '; Secure' : '');
  const clearCookie = `${cookieName}=; Max-Age=0${cookieSuffix}`;
  let redirect;
  try { redirect = new URL(redirectUri); } catch {}
  const enabled = Boolean(typeof clientId === 'string' && clientId.trim() && typeof clientSecret === 'string' && clientSecret.trim() && typeof cookieSecret === 'string' && cookieSecret.length >= 20 && redirect && !redirect.username && !redirect.password && !redirect.hash && !redirect.search && (redirect.protocol === 'https:' || !secureCookies && redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)));
  const key = crypto.createHash('sha256').update(String(cookieSecret)).digest();
  const pending = new Map();
  let keyCache = null, keyCacheUntil = 0, keyRequest = null, lastKeyFetch = -Infinity;

  function encode(payload) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(cookieName));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  function decode(header) {
    const matches = String(header || '').split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName + '='));
    if (matches.length !== 1) throw fail('Sesiunea Google lipsește sau a expirat. Reîncearcă autentificarea.');
    const encoded = matches[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{80,2048}$/.test(encoded)) throw fail('Sesiunea Google nu este validă. Reîncearcă autentificarea.');
    try {
      const data = Buffer.from(encoded, 'base64url'), decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(cookieName)); decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { throw fail('Sesiunea Google nu este validă. Reîncearcă autentificarea.'); }
  }
  function cleanPending() { for (const [state, expiry] of pending) if (expiry <= now()) pending.delete(state); }
  function begin() {
    if (!enabled) throw unavailable();
    cleanPending();
    if (pending.size >= 500) throw fail('Sunt prea multe conectări Google în curs. Reîncearcă mai târziu.', 503);
    const state = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
    const expiresAt = now() + TTL;
    pending.set(state, expiresAt);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return { url: url.href, cookie: `${cookieName}=${encode({ state, nonce, verifier, expiresAt })}; Max-Age=600${cookieSuffix}` };
  }
  async function fetchJson(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw fail('Google nu răspunde momentan. Reîncearcă autentificarea.', 502); }
    if (!response.ok) throw fail('Google nu a putut confirma autentificarea. Reîncearcă.', 502);
    // Limits both streamed production responses and the plain Response fixtures in tests.
    const reader = response.body?.getReader();
    let text;
    if (reader) {
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 256 * 1024) { await reader.cancel(); throw Error('oversized'); }
          chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
      } catch { throw fail('Răspunsul Google nu poate fi verificat. Reîncearcă.', 502); }
      finally { reader.releaseLock(); }
    } else {
      try { text = await response.text(); } catch { throw fail('Răspunsul Google nu poate fi verificat. Reîncearcă.', 502); }
      if (Buffer.byteLength(text) > 256 * 1024) throw fail('Răspunsul Google nu poate fi verificat. Reîncearcă.', 502);
    }
    try { return JSON.parse(text); } catch { throw fail('Răspunsul Google nu poate fi verificat. Reîncearcă.', 502); }
  }
  async function keys(force = false) {
    if (keyCache && !force && keyCacheUntil > now()) return keyCache;
    if (keyRequest) return keyRequest;
    // Unknown key IDs must not let arbitrary callback tokens flood Google's JWKS endpoint.
    if (force && now() - lastKeyFetch < 30000) return keyCache || [];
    lastKeyFetch = now();
    keyRequest = (async () => {
      const body = await fetchJson(KEYS_URL);
      if (!Array.isArray(body?.keys) || !body.keys.length || body.keys.length > 20) throw fail('Cheile Google nu pot fi verificate momentan.', 502);
      keyCache = body.keys.filter(item => item && item.kty === 'RSA' && (!item.use || item.use === 'sig') && (!item.alg || item.alg === 'RS256') && typeof item.kid === 'string' && typeof item.n === 'string' && typeof item.e === 'string');
      keyCacheUntil = now() + 60 * 60 * 1000;
      return keyCache;
    })();
    try { return await keyRequest; } finally { keyRequest = null; }
  }
  async function identityFromToken(token, nonce) {
    if (typeof token !== 'string' || token.length > 16000) throw fail('Identitatea Google nu a putut fi verificată.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw fail('Identitatea Google nu a putut fi verificată.');
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw fail('Identitatea Google nu a putut fi verificată.'); }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || header.crit || !claims || typeof claims !== 'object') throw fail('Identitatea Google nu a putut fi verificată.');
    let candidates = await keys();
    let jwk = candidates.find(item => item.kid === header.kid);
    if (!jwk) { candidates = await keys(true); jwk = candidates.find(item => item.kid === header.kid); }
    let signatureValid = false;
    try {
      const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      if (publicKey.asymmetricKeyDetails?.modulusLength >= 2048) signatureValid = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'));
    } catch {}
    const seconds = now() / 1000;
    if (!signatureValid || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== clientId || claims.azp !== undefined && claims.azp !== clientId || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || claims.exp <= claims.iat || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || !equal(claims.nonce, nonce)) throw fail('Identitatea Google nu a putut fi verificată.');
    return { sub: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : '' };
  }
  async function finish(callbackUrl, cookieHeader) {
    if (!enabled) throw unavailable();
    let url;
    try { url = new URL(callbackUrl); } catch { throw fail('Răspunsul de autentificare Google nu este valid.'); }
    // The integration passes the configured redirect origin plus the actual callback query.
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw fail('Adresa de autentificare Google nu este validă.');
    cleanPending();
    const payload = decode(cookieHeader);
    if (url.searchParams.getAll('state').length !== 1 || !equal(url.searchParams.get('state'), payload.state) || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now() || !pending.has(payload.state)) throw fail('Sesiunea Google a expirat sau nu corespunde. Reîncearcă autentificarea.');
    pending.delete(payload.state);
    if (url.searchParams.has('error')) throw fail('Conectarea Google a fost anulată. Poți folosi utilizatorul și parola.');
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096) throw fail('Codul Google lipsește sau nu este valid.');
    const data = await fetchJson(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: payload.verifier }).toString() });
    return { identity: await identityFromToken(data?.id_token, payload.nonce), clearCookie };
  }
  return { enabled, begin, finish, clearCookie };
}

module.exports = { createGoogleAuth };
