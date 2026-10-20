const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGoogleAuth } = require('../google-auth');
const clientId = 'nova-test.apps.googleusercontent.com';
const redirectUri = 'https://nova.example/api/auth/google/callback';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'google-test-key', use: 'sig', alg: 'RS256' };
function fixture({ claims = {}, signingKey = pair.privateKey, tokenBody, keyBody, fetchFailure = false, config = {} } = {}) {
  let clock = Date.parse('2026-10-20T14:00:00Z'), login, posted, calls = [];
  const auth = createGoogleAuth({ clientId, clientSecret: 'oauth-secret-for-test-only', redirectUri, cookieSecret: 'cookie-secret-for-test-only', now: () => clock, ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (fetchFailure) throw Error('private provider failure');
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(keyBody ?? { keys: [jwk] });
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      posted = new URLSearchParams(options.body);
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const data = { iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub-12345', email: 'visitor@example.com', email_verified: true, name: 'Nova Visitor', iat: Math.floor(clock / 1000) - 1, exp: Math.floor(clock / 1000) + 3600, nonce: login.searchParams.get('nonce'), ...claims };
      const body = Buffer.from(JSON.stringify(data)).toString('base64url');
      const signature = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), signingKey).toString('base64url');
      return Response.json(tokenBody ?? { id_token: head + '.' + body + '.' + signature });
    }
  });
  function begin() { const started = auth.begin(); login = new URL(started.url); return { ...started, cookieHeader: started.cookie.split(';')[0] }; }
  function callback(state = login.searchParams.get('state')) { return redirectUri + '?' + new URLSearchParams({ state, code: 'valid-code' }); }
  return { auth, begin, callback, calls, posted: () => posted, advance(ms) { clock += ms; } };
}

test('Google remains unavailable unless all required configuration exists and redirect is safe', () => {
  for (const config of [{ clientId: '' }, { clientSecret: '' }, { redirectUri: '' }, { cookieSecret: '' }, { redirectUri: 'http://nova.example/callback' }, { redirectUri: 'https://user:pass@nova.example/callback' }, { redirectUri: 'https://nova.example/callback#fragment' }]) {
    const { auth, calls } = fixture({ config });
    assert.equal(auth.enabled, false); assert.throws(() => auth.begin(), { status: 503 }); assert.equal(calls.length, 0);
  }
  assert.equal(fixture().auth.enabled, true);
  assert.equal(fixture({ config: { redirectUri: 'http://127.0.0.1:4173/api/auth/google/callback', secureCookies: false } }).auth.enabled, true);
});

test('Google sign-in uses bound state, PKCE, nonce, secure cookie and verified signed identity', async () => {
  const f = fixture(), start = f.begin(), login = new URL(start.url);
  assert.equal(login.origin, 'https://accounts.google.com');
  assert.equal(login.searchParams.get('scope'), 'openid email profile');
  assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  assert.match(start.cookie, /^__Host-nova_google_oauth=/);
  assert.match(start.cookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(start.cookie, /valid-code|nonce|verifier/);
  const result = await f.auth.finish(f.callback(), start.cookieHeader);
  assert.deepEqual(result.identity, { sub: 'google-sub-12345', email: 'visitor@example.com', name: 'Nova Visitor' });
  assert.match(result.clearCookie, /Max-Age=0/);
  assert.equal(f.posted().get('redirect_uri'), redirectUri);
  assert.equal(f.posted().get('grant_type'), 'authorization_code');
  assert.equal(crypto.createHash('sha256').update(f.posted().get('code_verifier')).digest('base64url'), login.searchParams.get('code_challenge'));
  const count = f.calls.length;
  await assert.rejects(f.auth.finish(f.callback(), start.cookieHeader), { status: 400 });
  assert.equal(f.calls.length, count, 'Replayed state must never exchange a token twice');
});

test('missing, altered, mismatched and expired OAuth state cannot contact token endpoint', async () => {
  for (const mode of ['missing', 'tampered', 'other-browser', 'wrong-state', 'expired', 'duplicate-state', 'wrong-origin']) {
    const f = fixture(), started = f.begin();
    let cookie = started.cookieHeader, callback = f.callback();
    if (mode === 'missing') cookie = '';
    if (mode === 'tampered') { const at = cookie.indexOf('=') + 1; cookie = cookie.slice(0, at) + (cookie[at] === 'A' ? 'B' : 'A') + cookie.slice(at + 1); }
    if (mode === 'other-browser') cookie = fixture().begin().cookieHeader;
    if (mode === 'wrong-state') callback = f.callback('wrong');
    if (mode === 'expired') f.advance(600001);
    if (mode === 'duplicate-state') callback += '&state=other';
    if (mode === 'wrong-origin') callback = callback.replace('nova.example', 'attacker.example');
    await assert.rejects(f.auth.finish(callback, cookie), { status: 400 }, mode);
    assert.equal(f.calls.length, 0, mode);
  }
});

test('Google cancellation consumes the state without treating denial as an identity', async () => {
  const f = fixture(), start = f.begin();
  const url = new URL(f.callback()); url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied');
  await assert.rejects(f.auth.finish(url.href, start.cookieHeader), /anulată/);
  await assert.rejects(f.auth.finish(f.callback(), start.cookieHeader), { status: 400 });
  assert.equal(f.calls.length, 0);
});

test('signed Google token rejects incorrect audience, issuer, nonce, dates and unverified email', async () => {
  for (const claims of [
    { aud: 'another-client' }, { iss: 'https://attacker.example' }, { nonce: 'wrong' }, { sub: '' }, { sub: null },
    { email_verified: false }, { email_verified: 'true' }, { email: 'not-an-email' },
    { exp: 1 }, { exp: '9999999999' }, { iat: 9999999999 }, { nbf: 9999999999 }, { azp: 'another-client' }
  ]) {
    const f = fixture({ claims }), start = f.begin();
    await assert.rejects(f.auth.finish(f.callback(), start.cookieHeader), /Identitatea Google/);
  }
});

test('Google token cannot authenticate using an unknown key or forged signature', async () => {
  for (const options of [{ signingKey: wrongPair.privateKey }, { keyBody: { keys: [{ ...jwk, kid: 'unknown-key' }] } }, { tokenBody: { id_token: 'not-a-token' } }]) {
    const f = fixture(options), start = f.begin();
    await assert.rejects(f.auth.finish(f.callback(), start.cookieHeader), /Identitatea Google/);
  }
});

test('Google network and malformed responses produce sanitized retry messages', async () => {
  for (const options of [{ fetchFailure: true }, { tokenBody: {} }, { keyBody: { keys: null } }]) {
    const f = fixture(options), start = f.begin();
    await assert.rejects(f.auth.finish(f.callback(), start.cookieHeader), error => !/private provider failure|oauth-secret/.test(error.message));
  }
});

test('pending Google attempts are bounded and expire to recover capacity', () => {
  const f = fixture();
  for (let i = 0; i < 500; i++) f.begin();
  assert.throws(() => f.begin(), { status: 503 });
  f.advance(600001);
  assert.match(f.begin().url, /^https:\/\/accounts\.google\.com/);
});
