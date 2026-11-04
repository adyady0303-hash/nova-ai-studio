const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const fixtureKeys = ['fixture-readiness-openai-key', 'fixture-readiness-gemini-key'];
const privateMarker = 'PRIVATE_READINESS_PROVIDER_DIAGNOSTIC';
const privateValues = [...fixtureKeys, privateMarker, 'private-user', 'private-password', 'private.example', '/srv/private/key.json'];
const statusStates = new Set(['unchecked', 'available', 'quota', 'auth_error', 'unavailable', 'network_error', 'invalid_response', 'timeout', 'model_error']);

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function assertSanitized(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of privateValues) assert.ok(!serialized.includes(secret), `Response exposed ${secret}`);
}

function assertStatus(status, state, model) {
  assert.ok(status && typeof status === 'object', 'Provider exposes its runtime status');
  assert.ok(statusStates.has(status.state), `Unknown runtime state: ${status.state}`);
  assert.equal(status.state, state);
  for (const property of ['checkedAt', 'model', 'error']) assert.ok(Object.hasOwn(status, property), `Runtime status includes ${property}`);
  if (state !== 'unchecked') {
    assert.ok(Number.isFinite(Date.parse(status.checkedAt)), 'A completed check has a timestamp');
    if (model) assert.equal(status.model, model);
  }
  if (!['unchecked', 'available'].includes(state)) assert.equal(typeof status.error, 'string');
  assertSanitized(status);
}

async function startApp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-provider-readiness-'));
  const controlPath = path.join(directory, 'control.json');
  const callsPath = path.join(directory, 'calls.jsonl');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  fs.writeFileSync(controlPath, JSON.stringify({ openai: 'success', gemini: 'success', delay: 35 }));
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const controlPath = ${JSON.stringify(controlPath)};
    const callsPath = ${JSON.stringify(callsPath)};
    const privateDetail = ${JSON.stringify(`${privateMarker} ${fixtureKeys.join(' ')} https://private-user:private-password@private.example/?key=${fixtureKeys[0]} /srv/private/key.json`)};
    let active = 0;
    const record = value => fs.appendFileSync(callsPath, JSON.stringify(value) + '\\n');
    function reply(status, payload, raw = false) {
      const text = raw ? payload : JSON.stringify(payload);
      return { status, ok: status >= 200 && status < 300,
        headers: { get: name => name.toLowerCase() === 'retry-after' && status === 503 ? '31' : name.toLowerCase() === 'content-type' ? 'application/json' : null },
        text: async () => text, json: async () => JSON.parse(text) };
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const provider = { 'api.openai.com': 'openai', 'generativelanguage.googleapis.com': 'gemini' }[parsed.hostname];
      if (!provider) { record({ operation: 'unexpected', hostname: parsed.hostname }); throw new Error('Unexpected provider destination'); }
      if (parsed.pathname.endsWith('/models')) {
        record({ operation: 'models', provider });
        if (JSON.parse(fs.readFileSync(controlPath, 'utf8')).emptyCatalog) return reply(200, { data: [] });
        return reply(200, { data: (provider === 'gemini'
          ? ['models/gemini-2.5-flash', 'models/gemini-2.0-flash', 'models/gemini-saved-model']
          : ['openai-saved-model']).map(id => ({ id })) });
      }
      if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('Unexpected provider route');
      const body = JSON.parse(options.body);
      const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      const mode = control[provider] || 'success';
      active++;
      record({ operation: 'chat', provider, model: body.model, active });
      try {
        await new Promise(resolve => setTimeout(resolve, control.delay || 0));
        if (mode === 'network' || mode === 'timeout') {
          throw new TypeError(privateDetail, { cause: Object.assign(new Error(privateDetail), { code: mode === 'timeout' ? 'UND_ERR_CONNECT_TIMEOUT' : 'ECONNRESET' }) });
        }
        if (mode === 'invalid-json') return reply(200, privateDetail, true);
        if (mode === 'missing-message') return reply(200, { choices: [], diagnostic: privateDetail });
        const status = { quota: 429, auth: 401, forbidden: 403, unavailable: 503, model: 404 }[mode];
        if (status) return reply(status, { error: { code: mode === 'quota' ? 'insufficient_quota' : mode === 'model' ? 'model_not_found' : 'provider_rejected', message: privateDetail } });
        return reply(200, { model: body.model, choices: [{ message: { role: 'assistant', content: 'Nova este conectată.' } }] });
      } finally { active--; }
    };
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough',
      NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5', AI_PROVIDER: 'openai', AI_FALLBACK_PROVIDERS: '',
      OPENAI_API_KEY: fixtureKeys[0], OPENAI_MODEL: 'openai-saved-model',
      GEMINI_API_KEY: fixtureKeys[1], GEMINI_MODEL: 'gemini-saved-model',
      ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '', MISTRAL_API_KEY: '',
      DEEPSEEK_API_KEY: '', XAI_API_KEY: '', TOGETHER_API_KEY: '', CUSTOM_OPENAI_API_KEY: ''
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
  let started = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    try { if ((await fetch(base + '/healthz')).ok) { started = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(started, logs);

  function request(cookie) {
    return (route, body, method = 'POST', headers = {}) => fetch(base + route, {
      method, headers: { cookie, origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const login = await request('')('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  const owner = request(login.headers.get('set-cookie').split(';', 1)[0]);
  const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const chatCalls = () => calls().filter(call => call.operation === 'chat');
  const clearCalls = () => fs.writeFileSync(callsPath, '');
  const control = value => fs.writeFileSync(controlPath, JSON.stringify({ delay: 35, ...value }));
  async function settings() {
    const response = await owner('/api/settings', undefined, 'GET');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assertSanitized(body);
    return body.settings;
  }
  async function configure() {
    const response = await owner('/api/settings', {
      providerId: 'openai', routes: { text: 'openai', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: false }
    });
    assert.equal(response.status, 200, await response.text());
  }
  async function diagnostics() {
    const response = await owner('/api/ai/diagnostics', {});
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assertSanitized(body);
    assert.equal(typeof body.version, 'string');
    assert.ok(Object.hasOwn(body, 'commit'));
    assert.ok(Array.isArray(body.providers));
    return body;
  }
  return { base, owner, request, calls, chatCalls, clearCalls, control, settings, configure, diagnostics };
}

test('provider readiness reflects real requests, preserves owner access and protects subscriber quotas', async t => {
  const app = await startApp(t);

  await t.test('saved keys are configured but unchecked, and default Ollama is excluded from text routing', async () => {
    const settings = await app.settings();
    const eligible = settings.providers.filter(profile => profile.textRoutingEligible).map(profile => profile.id).sort();
    assert.deepEqual(eligible, ['gemini', 'openai']);
    for (const id of ['openai', 'gemini']) {
      const profile = settings.providers.find(candidate => candidate.id === id);
      assert.equal(profile.apiKeyConfigured, true);
      assert.equal(profile.ready.text, true, 'Existing settings readiness field remains compatible');
      assertStatus(profile.status, 'unchecked');
    }
    assert.equal(settings.providers.find(profile => profile.id === 'ollama').textRoutingEligible, false);
    assert.equal(app.calls().length, 0, 'Reading saved settings does not contact any provider');
  });

  await t.test('the owner can inspect the selected provider catalog without marking chat as available', async () => {
    const response = await app.owner('/api/ai/models?provider=gemini', undefined, 'GET');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.provider, 'gemini');
    assert.equal(body.configuredModel, 'gemini-saved-model');
    const ids = body.models.map(model => typeof model === 'string' ? model : model.id);
    assert.ok(ids.includes('gemini-2.5-flash'));
    assert.ok(ids.includes(body.recommendedModel));
    assertSanitized(body);
    assert.deepEqual(app.calls(), [{ operation: 'models', provider: 'gemini' }]);
    for (const id of ['openai', 'gemini']) assertStatus((await app.settings()).providers.find(profile => profile.id === id).status, 'unchecked');
  });

  await t.test('an empty live catalog never presents the saved model as available', async () => {
    app.control({ emptyCatalog: true });
    const response = await app.owner('/api/ai/models?provider=gemini', undefined, 'GET');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.models, []);
    assert.equal(body.recommendedModel, '');
    assert.equal(body.configuredModel, 'gemini-saved-model');
    app.control({});
  });

  await t.test('batch probes distinguish quota from availability and persist safe results to settings', async () => {
    app.clearCalls();
    app.control({ openai: 'quota', gemini: 'success' });
    const body = await app.diagnostics();
    const saved = await app.settings();
    assert.equal(body.providers.length, saved.providers.length, 'Diagnostics includes configured and unconfigured profiles');
    for (const [id, state, model] of [['openai', 'quota', 'openai-saved-model'], ['gemini', 'available', 'gemini-saved-model']]) {
      const row = body.providers.find(provider => provider.id === id);
      assert.equal(row.configured, true);
      assert.equal(row.eligible, true);
      assert.equal(typeof row.name, 'string');
      assertStatus(row.status, state, model);
      assert.deepEqual(saved.providers.find(provider => provider.id === id).status, row.status);
    }
    const ollama = body.providers.find(provider => provider.id === 'ollama');
    assert.equal(ollama.eligible, false);
    assertStatus(ollama.status, 'unchecked');
    assert.deepEqual(app.chatCalls().map(call => call.provider).sort(), ['gemini', 'openai']);
    assert.equal(Math.max(...app.chatCalls().map(call => call.active)), 2, 'The two eligible probes run concurrently');
    assert.ok(app.calls().every(call => call.operation !== 'unexpected'), 'Default local Ollama is never contacted');
    const ownerAccount = await (await app.owner('/api/auth/me', undefined, 'GET')).json();
    assert.equal(ownerAccount.dailyLimit, null);
    assert.equal(ownerAccount.remainingToday, null);
  });

  await t.test('a provider retry delay longer than the probe budget returns one classified 503 result', async () => {
    app.clearCalls();
    app.control({ openai: 'success', gemini: 'unavailable' });
    const body = await app.diagnostics();
    assertStatus(body.providers.find(provider => provider.id === 'gemini').status, 'unavailable', 'gemini-saved-model');
    assert.equal(app.chatCalls().filter(call => call.provider === 'gemini').length, 1, 'Retry-After: 31 cannot fit into a 15-second probe');
    assertStatus((await app.settings()).providers.find(provider => provider.id === 'gemini').status, 'unavailable');
  });

  for (const [mode, state] of [['auth', 'auth_error'], ['network', 'network_error'], ['invalid-json', 'invalid_response'], ['missing-message', 'invalid_response'], ['timeout', 'timeout'], ['model', 'model_error']]) {
    await t.test(`batch probes classify ${mode} without leaking provider diagnostics`, async () => {
      app.control({ openai: mode, gemini: 'success' });
      const body = await app.diagnostics();
      assertStatus(body.providers.find(provider => provider.id === 'openai').status, state, 'openai-saved-model');
    });
  }

  await t.test('an owner tests an explicit saved provider and model independently of the active route', async () => {
    await app.configure();
    app.clearCalls();
    app.control({ openai: 'success', gemini: 'success' });
    const response = await app.owner('/api/ai/test', { providerId: 'gemini' });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.connected, true);
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, 'gemini-saved-model');
    assert.deepEqual(app.chatCalls().map(call => [call.provider, call.model]), [['gemini', 'gemini-saved-model']]);
    assertStatus((await app.settings()).providers.find(profile => profile.id === 'gemini').status, 'available', 'gemini-saved-model');
  });

  await t.test('ordinary chat requests refresh the same provider status on success and failure', async () => {
    const chat = () => app.owner('/api/chat', { model: 'openai-saved-model', task: 'text', messages: [{ role: 'user', content: 'Salut' }] });
    app.control({ openai: 'success', gemini: 'success' });
    let response = await chat();
    assert.equal(response.status, 200, await response.text());
    assertStatus((await app.settings()).providers.find(profile => profile.id === 'openai').status, 'available', 'openai-saved-model');
    app.control({ openai: 'quota', gemini: 'success' });
    response = await chat();
    const failure = await response.text();
    assert.equal(response.status, 429, failure);
    assertSanitized(failure);
    assertStatus((await app.settings()).providers.find(profile => profile.id === 'openai').status, 'quota', 'openai-saved-model');
  });

  await t.test('invalid methods, cross-origin requests and malformed profiles never start provider probes', async () => {
    app.clearCalls();
    let response = await app.owner('/api/ai/diagnostics', undefined, 'GET');
    assert.ok([404, 405].includes(response.status));
    response = await app.owner('/api/ai/diagnostics', {}, 'POST', { origin: 'https://attacker.example' });
    assert.equal(response.status, 403);
    response = await app.owner('/api/ai/diagnostics', {}, 'POST', { 'content-type': 'text/plain' });
    assert.equal(response.status, 415);
    response = await app.owner('/api/ai/models?provider=missing-provider', undefined, 'GET');
    assert.equal(response.status, 400);
    response = await app.owner('/api/ai/test', { providerId: 'missing-provider' });
    assert.equal(response.status, 400);
    assert.equal(app.calls().length, 0);
  });

  await t.test('subscribers cannot enumerate catalogs, run owner batches, redirect tests or bypass their quota', async () => {
    app.control({ openai: 'success', gemini: 'success' });
    const registration = await app.request('')('/api/auth/register', { username: 'readiness-visitor', password: 'pass1234' });
    assert.equal(registration.status, 201);
    const visitor = app.request(registration.headers.get('set-cookie').split(';', 1)[0]);
    app.clearCalls();
    for (const [route, body, method] of [['/api/ai/models?provider=gemini', undefined, 'GET'], ['/api/ai/diagnostics', {}, 'POST']]) {
      const response = await visitor(route, body, method);
      assert.equal(response.status, 403, await response.text());
    }
    assert.equal(app.calls().length, 0, 'Owner-only operations are rejected before contacting providers');
    const directed = await visitor('/api/ai/test', { providerId: 'gemini', model: 'untrusted-model' });
    assert.ok([200, 403].includes(directed.status));
    let successes = 0;
    if (directed.status === 200) {
      const body = await directed.json();
      assert.equal(body.provider, 'openai');
      assert.equal(body.model, 'openai-saved-model');
      successes++;
    }
    while (successes < 5) {
      const response = await visitor('/api/ai/test', {});
      assert.equal(response.status, 200, await response.text());
      successes++;
    }
    const exhausted = await visitor('/api/ai/test', {});
    assert.equal(exhausted.status, 429);
    const account = await (await visitor('/api/auth/me', undefined, 'GET')).json();
    assert.equal(account.quotaRemaining, 0);
    assert.equal(app.chatCalls().length, 5, 'Five subscriber units authorize exactly five upstream requests');
    assert.ok(app.chatCalls().every(call => call.provider === 'openai' && call.model === 'openai-saved-model'));
  });
  await t.test('an explicit Gemini save overrides stale OpenAI routing and survives settings reload', async () => {
    app.control({ openai: 'quota', gemini: 'success' });
    const saved = await app.owner('/api/settings', { providerId:'gemini',selectForChat:true,
      routes:{text:'openai',image:'openai',speech:'openai',autoSelect:true,autoFallback:true} });
    assert.equal(saved.status,200,await saved.clone().text());
    const configured=(await saved.json()).settings;
    assert.equal(configured.routes.text,'gemini');
    assert.equal(configured.routes.autoSelect,false);
    assert.equal(configured.routes.autoFallback,false);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await app.settings()).routes.text,'gemini');
    app.clearCalls();
    const reply=await app.owner('/api/chat',{model:'gemini-saved-model',task:'text',messages:[{role:'user',content:'Salut'}]});
    assert.equal(reply.status,200,await reply.clone().text());
    assert.equal((await reply.json()).provider,'gemini');
    assert.deepEqual(app.chatCalls().map(call=>call.provider),['gemini']);
  });

});
