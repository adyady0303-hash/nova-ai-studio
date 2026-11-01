const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, child, logs) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Serverul de test nu a pornit.\n${logs()}`);
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] || '';
}

test('multi-provider routing keeps secrets server-side, constrains subscribers and falls back only on transient errors', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-multi-provider-'));
  const callsPath = path.join(directory, 'provider-calls.jsonl');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const callsPath = ${JSON.stringify(callsPath)};
    function reply(status, data, contentType = 'application/json') {
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        status, ok: status >= 200 && status < 300,
        headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
        text: async () => body,
        json: async () => JSON.parse(body),
        arrayBuffer: async () => Buffer.from(body)
      };
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const requestBody = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      const provider = parsed.hostname === 'custom.example' ? 'custom'
        : parsed.hostname === 'api.openai.com' ? 'openai'
          : parsed.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : '';
      if (!provider) throw new Error('Destinație neașteptată: ' + parsed.hostname);
      fs.appendFileSync(callsPath, JSON.stringify({ provider, path: parsed.pathname, model: requestBody?.model || '', messages: requestBody?.messages || [] }) + '\\n');
      if (parsed.pathname.endsWith('/models')) {
        if (parsed.pathname.includes('/catalogless/')) return reply(404, { error: { message: 'catalog absent' } });
        const models = provider === 'custom' ? ['llama-3.3-70b', 'custom-primary'] : [provider === 'openai' ? 'openai-fallback' : 'gemini-primary'];
        return reply(200, { data: models.map(id => ({ id })) });
      }
      if (parsed.pathname.endsWith('/images/generations')) {
        return reply(200, { data: [{ b64_json: 'aW1hZ2U=' }] });
      }
      if (parsed.pathname.endsWith('/chat/completions')) {
        const prompt = requestBody?.messages?.filter(message => message.role === 'user').at(-1)?.content || '';
        if (provider === 'custom' && prompt.includes('TRANSIENT')) return reply(429, { error: { message: 'temporar limitat' } });
        if (provider === 'custom' && prompt.includes('AUTH')) return reply(401, { error: { message: 'cheie respinsă' } });
        return reply(200, { choices: [{ message: { role: 'assistant', content: 'Răspuns ' + provider } }], model: requestBody.model });
      }
      return reply(404, { error: { message: 'rută absentă' } });
    };
  `);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough',
      NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5',
      AI_PROVIDER: 'anthropic', AI_FALLBACK_PROVIDERS: 'openai', ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: 'openai-secret-not-real', OPENAI_MODEL: 'openai-fallback',
      OPENAI_IMAGE_MODEL: 'openai-image', GEMINI_API_KEY: 'gemini-secret-not-real', GEMINI_MODEL: 'gemini-primary'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForServer(base, child, () => logs);

  const ownerLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-password-long-enough' })
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = cookieFrom(ownerLogin);
  const ownerRequest = (route, body, method = 'POST') => fetch(base + route, {
    method, headers: { cookie: ownerCookie, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const automaticSettings = await (await fetch(base + '/api/settings', { headers: { cookie: ownerCookie } })).json();
  assert.equal(automaticSettings.settings.routes.text, 'anthropic');
  assert.equal(automaticSettings.settings.routes.autoSelect, true);
  assert.equal(automaticSettings.settings.platform, 'openai', 'Nova selectează automat primul profil configurat');

  const configured = await ownerRequest('/api/settings', {
    providerId: 'custom', baseUrl: 'https://custom.example/v1', apiKey: 'custom-secret-not-real',
    textModel: 'custom-primary', imageModel: 'custom-image', speechModel: 'custom-speech', voice: 'nova',
    routes: { text: 'custom', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: true },
    search: { provider: 'bing', apiKey: '', clearApiKey: false }
  });
  const configuredText = await configured.text();
  assert.equal(configured.status, 200, configuredText);
  const configuredBody = JSON.parse(configuredText);
  assert.match(configuredBody.notice, /criptate/i);
  const ownerSettings = await (await fetch(base + '/api/settings', { headers: { cookie: ownerCookie } })).json();
  const serializedSettings = JSON.stringify(ownerSettings);
  for (const secret of ['custom-secret-not-real', 'openai-secret-not-real', 'gemini-secret-not-real']) {
    assert.doesNotMatch(serializedSettings, new RegExp(secret));
  }
  assert.deepEqual(ownerSettings.settings.routes, { text: 'custom', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: true });
  assert.equal(ownerSettings.settings.providers.find(provider => provider.id === 'custom').apiKeyConfigured, true);

  const ownerHealth = await (await fetch(base + '/api/health', { headers: { cookie: ownerCookie } })).json();
  assert.equal(ownerHealth.connected, true);
  assert.deepEqual(ownerHealth.models, ['llama-3.3-70b', 'custom-primary'], 'catalogul custom nu trebuie filtrat ca un catalog OpenAI oficial');
  assert.deepEqual(ownerHealth.fallbacks?.map(item => item.provider), ['openai'], 'health expune exact rezerva unică folosită la runtime');

  const explicitOpenAiCustomUrl = await ownerRequest('/api/settings', {
    providerId: 'openai', baseUrl: 'https://custom.example/v1', textModel: 'should-not-save',
    routes: { text: 'custom', image: 'openai', speech: 'openai', autoSelect: true, autoFallback: true },
    search: { provider: 'bing' }
  });
  assert.equal(explicitOpenAiCustomUrl.status, 400);
  assert.match((await explicitOpenAiCustomUrl.json()).error, /custom/i);

  const crossOriginSettings = await fetch(base + '/api/settings', {
    method: 'POST', headers: { cookie: ownerCookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'custom', baseUrl: 'https://attacker.example/v1', textModel: 'stolen' })
  });
  assert.equal(crossOriginSettings.status, 403);
  const nonJsonSettings = await fetch(base + '/api/settings', {
    method: 'POST', headers: { cookie: ownerCookie, origin: base, 'content-type': 'text/plain' },
    body: JSON.stringify({ providerId: 'custom', baseUrl: 'https://attacker.example/v1', textModel: 'stolen' })
  });
  assert.equal(nonJsonSettings.status, 415);

  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'subscriber', password: 'pass1234' })
  });
  assert.equal(registration.status, 201);
  const subscriberCookie = cookieFrom(registration);
  const subscriberRequest = (route, body, method = 'POST') => fetch(base + route, {
    method, headers: { cookie: subscriberCookie, origin: base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.equal((await subscriberRequest('/api/settings', { providerId: 'openai' })).status, 403);
  const subscriberSettingsText = await (await fetch(base + '/api/settings', { headers: { cookie: subscriberCookie } })).text();
  assert.doesNotMatch(subscriberSettingsText, /custom-secret-not-real|openai-secret-not-real|gemini-secret-not-real|custom\.example/);

  const normal = await subscriberRequest('/api/chat', { model: 'forged-model', messages: [{ role: 'user', content: 'NORMAL' }] });
  assert.equal(normal.status, 200);
  const normalBody = await normal.json();
  assert.equal(normalBody.model, 'custom-primary');
  assert.equal(normalBody.provider, 'custom');
  let calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.at(-1).provider, 'custom');
  assert.equal(calls.at(-1).model, 'custom-primary', 'subscriberul nu poate impune un model arbitrar');

  const beforeFallback = await (await fetch(base + '/api/auth/me', { headers: { cookie: subscriberCookie } })).json();
  const transient = await subscriberRequest('/api/chat', { model: 'forged-again', messages: [{ role: 'user', content: 'TRANSIENT' }] });
  assert.equal(transient.status, 200);
  const transientBody = await transient.json();
  assert.equal(transientBody.provider, 'openai');
  assert.equal(transientBody.model, 'openai-fallback');
  const afterFallback = await (await fetch(base + '/api/auth/me', { headers: { cookie: subscriberCookie } })).json();
  assert.equal(beforeFallback.quotaRemaining - afterFallback.quotaRemaining, 1, 'fallback-ul trebuie să consume o singură unitate Nova');
  calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(calls.slice(-2).map(call => call.provider), ['custom', 'openai']);

  const beforeAuthCalls = calls.length;
  const rejected = await subscriberRequest('/api/chat', { model: 'forged-auth', messages: [{ role: 'user', content: 'AUTH' }] });
  assert.equal(rejected.status, 502, 'un 401 extern nu trebuie confundat cu expirarea sesiunii Nova');
  assert.equal((await rejected.json()).providerError, true);
  calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.length, beforeAuthCalls + 1);
  assert.equal(calls.at(-1).provider, 'custom', '401 nu trebuie să declanșeze fallback');

  const image = await ownerRequest('/api/media/image', { prompt: 'Rutare imagine' });
  assert.equal(image.status, 200, await image.text());
  calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.at(-1).provider, 'openai');
  assert.equal(calls.at(-1).model, 'openai-image');

  const catalogless = await ownerRequest('/api/settings', {
    providerId: 'custom', baseUrl: 'https://custom.example/catalogless', apiKey: 'custom-secret-not-real',
    textModel: 'custom-no-catalog', imageModel: 'custom-image', speechModel: 'custom-speech', voice: 'nova',
    routes: { text: 'custom', image: 'openai', speech: 'openai', autoFallback: true },
    search: { provider: 'bing' }
  });
  assert.equal(catalogless.status, 200, await catalogless.text());
  const cataloglessHealth = await (await fetch(base + '/api/health', { headers: { cookie: ownerCookie } })).json();
  assert.equal(cataloglessHealth.connected, true);
  assert.deepEqual(cataloglessHealth.models, ['custom-no-catalog']);
  assert.match(cataloglessHealth.version, /catalog \/models indisponibil/);

  const poolProviders = [];
  for (let index = 0; index < 3; index++) {
    const response = await ownerRequest('/api/chat', { model: 'custom-no-catalog', messages: [{ role: 'user', content: `POOL ${index}` }] });
    assert.equal(response.status, 200);
    poolProviders.push((await response.json()).provider);
  }
  assert.deepEqual(poolProviders, ['custom', 'openai', 'gemini'], 'modul automat folosește pe rând toate profilurile configurate');
});
