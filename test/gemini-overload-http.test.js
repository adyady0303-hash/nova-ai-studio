const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const originalModel = 'gemini-2.5-flash';
const alternateModels = ['gemini-2.5-flash-lite', 'gemini-2.0-flash'];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, description, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(description);
}

test('real Gemini HTTP 503 recovery is bounded, cancellable and keeps the configured model', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gemini-overload-'));
  const controlPath = path.join(directory, 'scenarios.json');
  const callsPath = path.join(directory, 'calls.jsonl');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  const config = { active: '', scenarios: {} };
  fs.writeFileSync(controlPath, JSON.stringify(config));
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const controlPath = ${JSON.stringify(controlPath)};
    const callsPath = ${JSON.stringify(callsPath)};
    const original = ${JSON.stringify(originalModel)};
    const alternatives = ${JSON.stringify(alternateModels)};
    const attempts = new Map();
    function record(call) { fs.appendFileSync(callsPath, JSON.stringify({ ...call, time: Date.now() }) + '\\n'); }
    function reply(status, payload, retryAfter) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return { status, ok: status >= 200 && status < 300,
        headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter ?? null : 'application/json' },
        text: async () => text, json: async () => JSON.parse(text) };
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const config = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      const body = options.body ? JSON.parse(options.body) : {};
      const prompt = body.messages?.filter(message => message.role === 'user').at(-1)?.content || '';
      const id = prompt.startsWith('OVERLOAD_CASE:') ? prompt.slice('OVERLOAD_CASE:'.length) : config.active;
      const scenario = config.scenarios[id] || {};
      const provider = parsed.hostname === 'generativelanguage.googleapis.com' ? 'gemini'
        : parsed.hostname === 'api.openai.com' ? 'openai' : '';
      if (!provider) throw new Error('Unexpected provider destination');
      if (parsed.pathname.endsWith('/models')) {
        record({ type: 'catalog', id, provider });
        if (scenario.hangCatalog) return new Promise((resolve, reject) => {
          const cancel = () => { record({ type: 'catalog-aborted', id, provider }); reject(options.signal.reason); };
          if (options.signal?.aborted) cancel();
          else options.signal?.addEventListener('abort', cancel, { once: true });
        });
        const models = scenario.noAlternatives ? [original, 'gemini-2.5-pro', 'gemini-embedding-001', 'gemini-2.5-flash-image']
          : [original, ...alternatives, 'gemini-3-pro', 'gemini-embedding-001', 'gemini-2.5-flash-image', 'gemini-2.5-flash-tts'];
        return reply(200, { data: models.map(model => ({ id: 'models/' + model })) });
      }
      if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('Unexpected provider route');
      const key = id + ':' + body.model;
      const attempt = (attempts.get(key) || 0) + 1;
      attempts.set(key, attempt);
      record({ type: 'chat', id, provider, model: body.model, attempt });
      if (scenario.behavior === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error('network'), { code: 'ECONNRESET' }) });
      if (scenario.behavior === 'synthetic503') throw Object.assign(new Error('synthetic failure'), { status: 503 });
      if (scenario.behavior === 'invalid') return reply(200, 'not valid JSON');
      if (scenario.behavior === 'status') return reply(scenario.status, { error: { message: 'Private fixture provider diagnostic', code: 'provider_rejected' } });
      const overloaded = scenario.behavior === 'all503' || scenario.behavior === 'cancel'
        || (scenario.behavior === 'retrySuccess' && body.model === original && attempt === 1)
        || (scenario.behavior === 'alternateSuccess' && body.model === original);
      if (overloaded) return reply(503, { error: { message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE', code: 503 } }, scenario.retryAfter);
      return reply(200, { model: body.model, choices: [{ message: { role: 'assistant', content: 'Răspuns Gemini recuperat' } }] });
    };
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough',
      AI_PROVIDER: 'gemini', AI_FALLBACK_PROVIDERS: '', NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5',
      GEMINI_API_KEY: 'fixture-gemini-overload-key', GEMINI_MODEL: originalModel,
      OPENAI_API_KEY: 'fixture-openai-configured-but-not-selected', OPENAI_MODEL: 'gpt-fixture',
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
  await waitUntil(async () => {
    if (child.exitCode !== null) assert.fail(logs);
    try { return (await fetch(base + '/healthz')).ok; } catch { return false; }
  }, 'Test server did not start: ' + logs);

  function request(cookie) {
    return (route, body, method = 'POST', options = {}) => fetch(base + route, {
      ...options, method, headers: { cookie, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const login = await request('')('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  const owner = request(login.headers.get('set-cookie').split(';', 1)[0]);
  const configured = await owner('/api/settings', { providerId: 'gemini', routes: { text: 'gemini', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: false } });
  assert.equal(configured.status, 200, await configured.text());
  const projectResponse = await owner('/api/projects', { name: 'Overload recovery', empty: true });
  assert.equal(projectResponse.status, 201);
  const project = (await projectResponse.json()).project.id;
  let sequence = 0;
  const allCalls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  function scenario(behavior, extra = {}) {
    const id = String(++sequence);
    config.active = id;
    config.scenarios[id] = { behavior, ...extra };
    fs.writeFileSync(controlPath, JSON.stringify(config));
    return {
      id,
      calls: () => allCalls().filter(call => call.type === 'chat' && call.id === id),
      catalogs: () => allCalls().filter(call => call.type === 'catalog' && call.id === id),
      body: { project, model: originalModel, task: 'text', messages: [{ role: 'user', content: 'OVERLOAD_CASE:' + id }] }
    };
  }
  async function unchangedModel() {
    const settings = (await (await owner('/api/settings', undefined, 'GET')).json()).settings;
    assert.equal(settings.textModel, originalModel, 'transient overload must not overwrite the saved model');
    assert.equal(settings.routes.autoSelect, false);
    assert.equal(settings.routes.autoFallback, false);
  }

  await t.test('retrying the same Gemini model once can recover chat and agent requests', async () => {
    for (const route of ['/api/chat', '/api/agent']) {
      const current = scenario('retrySuccess');
      const response = await owner(route, current.body);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.provider, 'gemini');
      assert.equal(body.model, originalModel);
      const calls = current.calls();
      assert.deepEqual(calls.map(call => call.model), [originalModel, originalModel]);
      assert.ok(calls[1].time - calls[0].time >= 850, '503 retry must back off rather than immediately hammer the model');
      assert.equal(current.catalogs().length, 0, 'same-model success needs no fallback catalog');
      await unchangedModel();
    }
  });

  await t.test('persistent overload uses a compatible flash alternative with attribution and no saved-model change', async () => {
    const current = scenario('alternateSuccess');
    const response = await owner('/api/chat', current.body);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.provider, 'gemini');
    assert.ok(alternateModels.includes(body.model), JSON.stringify(body));
    assert.deepEqual(current.calls().map(call => call.model), [originalModel, originalModel, body.model]);
    assert.ok(current.catalogs().length >= 1);
    await unchangedModel();
  });

  await t.test('all-overloaded models stop after two original attempts and two distinct compatible alternatives', async () => {
    const current = scenario('all503');
    const response = await owner('/api/chat', current.body);
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.match(body.error, /Gemini|temporar|supraîncărc|HTTP 503/i);
    const calls = current.calls();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.slice(0, 2).map(call => call.model), [originalModel, originalModel]);
    assert.deepEqual(new Set(calls.slice(2).map(call => call.model)), new Set(alternateModels));
    assert.ok(calls.every(call => call.provider === 'gemini'), 'manual routing must not invoke another configured provider');
    await unchangedModel();
  });

  await t.test('no comparable flash chat model means only two original attempts', async () => {
    const current = scenario('all503', { noAlternatives: true });
    const response = await owner('/api/chat', current.body);
    assert.equal(response.status, 503, await response.text());
    assert.deepEqual(current.calls().map(call => call.model), [originalModel, originalModel]);
    await unchangedModel();
  });

  await t.test('auth, request, quota, HTTP500, network, synthetic503 and invalid responses are not overload-retried', async () => {
    for (const extra of [
      { behavior: 'status', status: 400 }, { behavior: 'status', status: 401 }, { behavior: 'status', status: 403 },
      { behavior: 'status', status: 429 }, { behavior: 'status', status: 500 },
      { behavior: 'network' }, { behavior: 'synthetic503' }, { behavior: 'invalid' }
    ]) {
      const current = scenario(extra.behavior, extra);
      const response = await owner('/api/chat', current.body);
      assert.ok(!response.ok, await response.text());
      assert.deepEqual(current.calls().map(call => [call.provider, call.model]), [['gemini', originalModel]], JSON.stringify(extra));
      assert.equal(current.catalogs().length, 0);
    }
  });

  await t.test('a subscriber overload recovery consumes exactly one Nova quota unit', async () => {
    const registration = await request('')('/api/auth/register', { username: 'overload-visitor', password: 'pass1234' });
    assert.equal(registration.status, 201);
    const subscriber = request(registration.headers.get('set-cookie').split(';', 1)[0]);
    const current = scenario('alternateSuccess');
    const response = await subscriber('/api/chat', current.body);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get('x-nova-ai-remaining'), '4');
    const me = await (await subscriber('/api/auth/me', undefined, 'GET')).json();
    assert.equal(me.quotaRemaining, 4);
    assert.equal(current.calls().length, 3);
    assert.ok(alternateModels.includes(body.model));
  });

  await t.test('the administrator connection test recovers overload of the configured Gemini model', async () => {
    const current = scenario('retrySuccess');
    const response = await owner('/api/ai/test', { model: originalModel });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.connected, true);
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, originalModel);
    assert.deepEqual(current.calls().map(call => call.model), [originalModel, originalModel]);
    await unchangedModel();
  });

  await t.test('Retry-After delays a same-model retry instead of retrying immediately', async () => {
    const current = scenario('retrySuccess', { retryAfter: '2' });
    const response = await owner('/api/chat', current.body);
    assert.equal(response.status, 200, await response.text());
    const calls = current.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].time - calls[0].time >= 1850, 'Retry-After: 2 must delay the retry for about two seconds');
  });

  await t.test('Retry-After exceeding the diagnostic operation budget stops without waiting or retrying', { timeout: 5000 }, async () => {
    const current = scenario('all503', { retryAfter: '31' });
    const response = await owner('/api/ai/test', { model: originalModel }, 'POST', { signal: AbortSignal.timeout(4000) });
    const body = await response.json();
    assert.equal(response.status, 502, JSON.stringify(body));
    assert.equal(body.connected, false);
    assert.match(body.error, /Gemini|HTTP 503|supraîncărc|temporar/i);
    assert.deepEqual(current.calls().map(call => call.model), [originalModel]);
    assert.equal(current.catalogs().length, 0);
  });

  await t.test('catalog-prefixed preferred models do not reappear as overload alternatives', async () => {
    const current = scenario('all503');
    const response = await owner('/api/chat', { ...current.body, model: 'models/' + originalModel });
    assert.equal(response.status, 503, await response.text());
    const calls = current.calls();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.slice(0, 2).map(call => call.model), [originalModel, originalModel]);
    assert.deepEqual(new Set(calls.slice(2).map(call => call.model)), new Set(alternateModels));
    assert.equal(calls.filter(call => call.model === originalModel).length, 2);
    await unchangedModel();
  });

  await t.test('disconnecting during live catalog retrieval aborts it and prevents alternate chat calls', { timeout: 10000 }, async () => {
    const current = scenario('all503', { hangCatalog: true });
    const controller = new AbortController();
    const requestPromise = owner('/api/chat', current.body, 'POST', { signal: controller.signal });
    const rejected = assert.rejects(requestPromise, { name: 'AbortError' });
    await waitUntil(() => current.catalogs().length === 1, 'live fallback catalog was not requested');
    controller.abort();
    await rejected;
    await waitUntil(() => allCalls().some(call => call.type === 'catalog-aborted' && call.id === current.id), 'catalog transport did not receive cancellation');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(current.calls().map(call => call.model), [originalModel, originalModel]);
  });

  await t.test('disconnecting during overload backoff prevents further provider calls', { timeout: 10000 }, async () => {
    for (const route of ['/api/chat', '/api/ai/test']) {
      const current = scenario('cancel', { retryAfter: '1' });
      const controller = new AbortController();
      const requestPromise = owner(route, current.body, 'POST', { signal: controller.signal });
      const rejected = assert.rejects(requestPromise, { name: 'AbortError' });
      await waitUntil(() => current.calls().length === 1, 'first overloaded call never started');
      controller.abort();
      await rejected;
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(current.calls().length, 1, route + ': a disconnected request must not continue retrying');
      assert.equal(current.catalogs().length, 0);
    }
  });
});
