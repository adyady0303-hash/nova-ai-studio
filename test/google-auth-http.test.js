const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..');

function cookieFor(response, name) {
  const cookies = response.headers.getSetCookie();
  return cookies.find(value => value.startsWith(name + '='))?.split(';')[0];
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('Google HTTP sign-in creates only a subscriber, reuses verified subject and isolates matching local identities', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-google-http-'));
  const preload = path.join(directory, 'google-provider.cjs');
  const callsFile = path.join(directory, 'provider-calls.jsonl');
  const dataDirectory = path.join(directory, 'store');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const clientId = 'nova-http-test.apps.googleusercontent.com';
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'http-google-key', alg: 'RS256', use: 'sig' };
  // This preload is confined to the spawned server. Production code has no fixture hooks.
  fs.writeFileSync(preload, `
const fs = require('node:fs'), crypto = require('node:crypto');
const privateKey = ${JSON.stringify(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))};
globalThis.fetch = async (url, options = {}) => {
  if (!['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs'].includes(url)) throw Error('Unexpected provider destination');
  fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ url }) + '\\n');
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [${JSON.stringify(jwk)}] });
  const body = new URLSearchParams(options.body), request = JSON.parse(Buffer.from(body.get('code'), 'base64url').toString('utf8'));
  if (body.get('client_id') !== ${JSON.stringify(clientId)} || !body.get('code_verifier') || body.get('redirect_uri') !== ${JSON.stringify(base + '/api/auth/google/callback')}) return Response.json({}, { status: 400 });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'http-google-key' })).toString('base64url');
  const claims = { iss: 'https://accounts.google.com', aud: ${JSON.stringify(clientId)}, iat: Math.floor(Date.now()/1000)-1, exp: Math.floor(Date.now()/1000)+3600, email_verified: true, ...request };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(header+'.'+payload), privateKey).toString('base64url');
  return Response.json({ id_token: header+'.'+payload+'.'+signature, access_token: 'fixture-access-token-never-for-browser' });
};
`, { mode: 0o600 });
  const child = spawn(process.execPath, ['--require', preload, path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: dataDirectory, DATABASE_URL: '', NOVA_STORAGE_DUAL_WRITE: '', NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'fixture-owner-password-long-enough', NOVA_DATA_ENCRYPTION_KEY: 'fixture-encryption-key-long-enough', GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 'fixture-client-secret', GOOGLE_REDIRECT_URI: base + '/api/auth/google/callback' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(ready, 'Google fixture server must start: ' + output);
  const post = (route, body, cookie = '') => fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: 'manual' });
  const me = cookie => fetch(base + '/api/auth/me', { headers: { cookie } });
  const callCount = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const accountPath = path.join(dataDirectory, 'data', 'subscriber-accounts.json');
  const accounts = () => JSON.parse(fs.readFileSync(accountPath, 'utf8')).users;
  async function begin() {
    const response = await fetch(base + '/api/auth/google', { redirect: 'manual' });
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get('location'));
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('redirect_uri'), base + '/api/auth/google/callback');
    const cookie = cookieFor(response, 'nova_google_oauth');
    assert(cookie);
    return { authorization, cookie };
  }
  function callbackFor(started, identity = {}, overrides = {}) {
    const query = new URLSearchParams({ state: started.authorization.searchParams.get('state'), code: Buffer.from(JSON.stringify({ sub: 'google-visitor-sub', email: 'visitor@example.com', name: 'visitor', nonce: started.authorization.searchParams.get('nonce'), ...identity })).toString('base64url'), ...overrides });
    return base + '/api/auth/google/callback?' + query;
  }
  async function complete(identity) {
    const started = await begin(), callback = callbackFor(started, identity);
    const response = await fetch(callback, { headers: { cookie: started.cookie }, redirect: 'manual' });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /location\.replace\("\/"\)/);
    assert.doesNotMatch(html, /fixture-client-secret|fixture-access-token|google-visitor-sub/);
    assert(response.headers.getSetCookie().some(cookie => cookie.startsWith('nova_google_oauth=; Max-Age=0')));
    const cookie = cookieFor(response, 'nova_session');
    assert(cookie, 'Google callback creates a real Nova session automatically');
    const account = await (await me(cookie)).json();
    assert.equal(account.role, 'subscriber');
    return { cookie, account, callback, stateCookie: started.cookie };
  }

  assert.deepEqual(await (await fetch(base + '/api/auth/options')).json(), { google: true });
  const loginHtml = await (await fetch(base + '/')).text();
  assert.match(loginHtml, /id="google-login"[^>]+href="\/api\/auth\/google" >/);
  const registered = await post('/api/auth/register', { username: 'visitor', password: 'visitor' });
  assert.equal(registered.status, 201);
  const localCookie = cookieFor(registered, 'nova_session');
  const localAccount = await (await me(localCookie)).json();
  // Simulate existing metadata with the same verified email/name. It must never bind identities.
  const store = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
  store.users[0].googleEmail = 'visitor@example.com'; store.users[0].displayName = 'visitor';
  fs.writeFileSync(accountPath, JSON.stringify(store));
  const bad = await begin(), before = callCount();
  const denied = await fetch(callbackFor(bad, {}, { state: 'unrelated-state' }), { headers: { cookie: bad.cookie }, redirect: 'manual' });
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get('location'), '/?auth=google-failed');
  assert.equal(cookieFor(denied, 'nova_session'), undefined);
  assert.equal(callCount(), before, 'Invalid state cannot exchange a Google token');
  assert.equal(accounts().length, 1);

  const first = await complete();
  assert.notEqual(first.account.id, localAccount.id);
  assert.match(first.account.username, /^google_[a-f0-9]{20}$/);
  assert.equal(accounts().length, 2);
  assert.equal(accounts().find(record => record.id === first.account.id).googleSub, 'google-visitor-sub');
  assert.equal((await post('/api/settings', { provider: 'openai' }, first.cookie)).status, 403, 'Google visitor cannot edit owner settings');
  const repeated = await complete({ email: 'changed-email@example.com' });
  assert.equal(repeated.account.id, first.account.id, 'Only stable Google subject decides account identity');
  assert.equal(accounts().length, 2);
  const other = await complete({ sub: 'another-google-sub', email: 'changed-email@example.com' });
  assert.notEqual(other.account.id, first.account.id, 'A matching email must not merge distinct Google subjects');
  assert.equal(accounts().length, 3);

  const replayCalls = callCount();
  const replay = await fetch(first.callback, { headers: { cookie: first.stateCookie }, redirect: 'manual' });
  assert.equal(replay.status, 303);
  assert.equal(cookieFor(replay, 'nova_session'), undefined);
  assert.equal(callCount(), replayCalls);
  const localLogin = await post('/api/auth/login', { username: 'visitor', password: 'visitor' });
  assert.equal(localLogin.status, 200);
  assert.equal((await (await me(cookieFor(localLogin, 'nova_session'))).json()).id, localAccount.id);
});
