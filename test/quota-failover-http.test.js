const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const providers = ['openai', 'gemini', 'groq'];
const fixtureKeys = providers.map(provider => `fixture-${provider}-key`);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function startApp(t, { autoSelect = true, autoFallback = false, primary = 'openai' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-quota-failover-'));
  const callsPath = path.join(directory, 'calls.jsonl');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const record = value => fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(value) + '\\n');
    function reply(status, data) {
      const text = JSON.stringify(data);
      return { status, ok: status >= 200 && status < 300,
        headers: { get: () => 'application/json' }, text: async () => text, json: async () => data };
    }
    function rejected(status) {
      return reply(status, { error: { code: status === 429 ? 'insufficient_quota' : 'provider_rejected',
        message: 'Private provider diagnostic: fixture-openai-key fixture-gemini-key fixture-groq-key' } });
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const provider = { 'api.openai.com': 'openai', 'generativelanguage.googleapis.com': 'gemini', 'api.groq.com': 'groq', 'openrouter.ai': 'openrouter' }[parsed.hostname];
      if (!provider) throw new Error('Unexpected provider destination: ' + parsed.hostname);
      if (parsed.pathname.endsWith('/models')) return reply(200, { data: [{ id: provider + '-primary' }] });
      if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('Unexpected provider route: ' + parsed.pathname);
      const body = JSON.parse(options.body);
      const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      record({ type: 'chat', provider, model: body.model, prompt });
      if (prompt === 'QUOTA_THEN_CANCEL' && provider === 'gemini') {
        return new Promise((resolve, reject) => {
          const cancel = () => { record({ type: 'aborted', provider, prompt }); reject(options.signal.reason); };
          if (options.signal?.aborted) cancel();
          else options.signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      if (${JSON.stringify(primary)} === 'openrouter' && provider === 'openai' && prompt.startsWith('PRIMARY_')) return rejected(429);
      if (provider === ${JSON.stringify(primary)} && prompt === 'PRIMARY_TIMEOUT') throw new DOMException('fixture timeout', 'TimeoutError');
      if (provider === ${JSON.stringify(primary)} && prompt === 'PRIMARY_NETWORK') throw Object.assign(new Error('fixture socket reset'), {code: 'ECONNRESET'});
      if (provider === ${JSON.stringify(primary)} && prompt === 'PRIMARY_GATEWAY') return rejected(502);
      const allStatus = /^ALL_STATUS_(\\d+)$/.exec(prompt);
      if (allStatus) return rejected(Number(allStatus[1]));
      if (prompt === 'ALL_QUOTA') return rejected(429);
      const openAiStatus = /^OPENAI_STATUS_(\\d+)$/.exec(prompt);
      if (openAiStatus && provider === 'openai') return rejected(Number(openAiStatus[1]));
      if (prompt.startsWith('QUOTA_THEN_') || prompt === 'OPENAI_QUOTA') {
        if (provider === 'openai') return rejected(429);
        if (provider === 'gemini' && prompt === 'QUOTA_THEN_AUTH') return rejected(401);
        if (provider === 'gemini' && prompt === 'QUOTA_THEN_SERVER_ERROR') return rejected(500);
        if (provider === 'gemini' && prompt === 'QUOTA_THEN_QUOTA') return rejected(429);
      }
      return reply(200, { choices: [{ message: { role: 'assistant', content: 'Answer from ' + provider } }], model: body.model });
    };
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough', NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5',
      AI_PROVIDER: primary, AI_FALLBACK_PROVIDERS: primary === 'openrouter' ? 'groq' : 'gemini',
      OPENAI_API_KEY: fixtureKeys[0], OPENAI_MODEL: 'openai-primary',
      GEMINI_API_KEY: primary === 'openrouter' ? '' : fixtureKeys[1], GEMINI_MODEL: 'gemini-primary',
      GROQ_API_KEY: fixtureKeys[2], GROQ_MODEL: 'groq-primary',
      ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: primary === 'openrouter' ? 'fixture-openrouter-key' : '', MISTRAL_API_KEY: '', DEEPSEEK_API_KEY: '',
      XAI_API_KEY: '', TOGETHER_API_KEY: '', CUSTOM_OPENAI_API_KEY: ''
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
  }, `Server did not start: ${logs}`);

  function request(cookie) {
    return (route, body, method = 'POST', options = {}) => fetch(base + route, {
      ...options, method, headers: { cookie, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const login = await request('')('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  const owner = request(login.headers.get('set-cookie').split(';', 1)[0]);
  const configure = async routes => {
    const response = await owner('/api/settings', {
      providerId: primary, routes: { text: primary, image: 'openai', speech: 'openai', autoSelect, autoFallback, ...routes }
    });
    assert.equal(response.status, 200, await response.text());
  };
  await configure();
  const allCalls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const calls = () => allCalls().filter(call => call.type === 'chat');
  const chat = (client, prompt, options = {}) => client('/api/chat', {
    model: 'owner-selected-model', messages: [{ role: 'user', content: prompt }]
  }, 'POST', options);
  async function subscriber() {
    const response = await request('')('/api/auth/register', { username: 'subscriber', password: 'pass1234' });
    assert.equal(response.status, 201);
    return request(response.headers.get('set-cookie').split(';', 1)[0]);
  }
  return { owner, subscriber, calls, allCalls, chat, configure };
}

test('automatic text quota failover preserves manual routing and subscriber quotas', async t => {
  await t.test('automatic owner requests recover from quota with alternate model attribution and no Nova quota', async t => {
    const app = await startApp(t);
    const response = await app.chat(app.owner, 'OPENAI_QUOTA');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, 'gemini-primary');
    assert.deepEqual(app.calls().map(call => [call.provider, call.model]), [
      ['openai', 'owner-selected-model'], ['gemini', 'gemini-primary']
    ]);
    for (let index = 0; index < 6; index++) {
      const additional = await app.chat(app.owner, 'OPENAI_QUOTA');
      assert.equal(additional.status, 200, await additional.text());
      assert.equal(additional.headers.get('x-nova-ai-remaining'), null);
    }
    const me = await (await app.owner('/api/auth/me', undefined, 'GET')).json();
    assert.equal(me.role, 'owner');
    assert.equal(me.dailyLimit, null);
    assert.equal(me.remainingToday, null);
  });

  await t.test('subscriber fallback consumes one unit and uses configured alternate model', async t => {
    const app = await startApp(t);
    const visitor = await app.subscriber();
    const response = await app.chat(visitor, 'OPENAI_QUOTA');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, 'gemini-primary');
    assert.equal(response.headers.get('x-nova-ai-remaining'), '4');
    const me = await (await visitor('/api/auth/me', undefined, 'GET')).json();
    assert.equal(me.quotaRemaining, 4);
    assert.deepEqual(app.calls().map(call => [call.provider, call.model]), [
      ['openai', 'openai-primary'], ['gemini', 'gemini-primary']
    ]);
  });

  await t.test('all-quota failure attempts each automatic provider once in circular order and hides diagnostics', async t => {
    const app = await startApp(t);
    for (let rotation = 0; rotation < providers.length; rotation++) {
      const before = app.calls().length;
      const response = await app.chat(app.owner, 'ALL_QUOTA', { signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      assert.equal(response.status, 429, body);
      assert.equal(JSON.parse(body).providerError, true);
      for (const fixtureKey of fixtureKeys) assert.ok(!body.includes(fixtureKey));
      const attempts = app.calls().slice(before).map(call => call.provider);
      assert.equal(attempts.length, providers.length);
      assert.equal(new Set(attempts).size, providers.length);
      const first = providers.indexOf(attempts[0]);
      assert.deepEqual(attempts, [...providers.slice(first), ...providers.slice(0, first)]);
    }
  });

  await t.test('manual routing does not silently switch providers on quota', async t => {
    const app = await startApp(t, { autoSelect: false });
    const response = await app.chat(app.owner, 'OPENAI_QUOTA');
    assert.equal(response.status, 429);
    assert.deepEqual(app.calls().map(call => call.provider), ['openai']);
  });

  await t.test('automatic routing without explicit fallback stops on non-quota provider errors', async t => {
    const app = await startApp(t);
    for (const status of [400, 401, 403, 500]) {
      const before = app.calls().length;
      const response = await app.chat(app.owner, `ALL_STATUS_${status}`);
      assert.equal(response.status, [401, 403].includes(status) ? 502 : status);
      const attempts = app.calls().slice(before);
      assert.equal(new Set(attempts.map(call => call.provider)).size, 1, 'non-quota errors do not switch providers');
      assert.equal(attempts.length, status === 503 && attempts[0].provider === 'gemini' ? 2 : 1);
    }
    for (const prompt of ['QUOTA_THEN_AUTH', 'QUOTA_THEN_SERVER_ERROR']) {
      // A fresh app fixes the first selected provider for this failure sequence.
      await t.test(prompt, async t => {
        const sequence = await startApp(t);
        const response = await sequence.chat(sequence.owner, prompt);
        assert.equal(response.status, prompt.endsWith('AUTH') ? 502 : 500);
        assert.deepEqual(sequence.calls().map(call => call.provider), ['openai', 'gemini']);
      });
    }
  });

  await t.test('automatic routing recovers a real service-unavailable response using another configured provider', async t => {
    const app = await startApp(t);
    const response = await app.chat(app.owner, 'OPENAI_STATUS_503');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).provider, 'gemini');
    assert.deepEqual(app.calls().map(call => call.provider), ['openai', 'gemini']);
  });

  for (const prompt of ['PRIMARY_TIMEOUT', 'PRIMARY_NETWORK', 'PRIMARY_GATEWAY']) {
    await t.test('automatic OpenRouter recovery: ' + prompt, async t => {
      const app = await startApp(t, { primary: 'openrouter' });
      const before = app.calls().length;
      const response = await app.chat(app.owner, prompt);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.provider, 'groq');
      assert.equal(body.model, 'groq-primary');
      const attempts = app.calls().slice(before).map(call => call.provider);
      assert.deepEqual(attempts, prompt === 'PRIMARY_TIMEOUT'
        ? ['openrouter', 'openai', 'groq'] : ['openrouter', 'openrouter', 'openai', 'groq']);
      const settings = await (await app.owner('/api/settings', undefined, 'GET')).json();
      assert.equal(settings.settings.routes.text, 'openrouter', 'recovery must not rewrite the saved route');
    });
  }

  await t.test('manual OpenRouter timeout does not change providers without fallback consent', async t => {
    const app = await startApp(t, { primary: 'openrouter', autoSelect: false });
    const response = await app.chat(app.owner, 'PRIMARY_TIMEOUT');
    assert.equal(response.status, 504);
    assert.deepEqual(app.calls().map(call => call.provider), ['openrouter']);
  });

  await t.test('explicit manual fallback retains its existing single alternate and transient-error behavior', async t => {
    const app = await startApp(t, { autoSelect: false, autoFallback: true });
    const recovered = await app.chat(app.owner, 'OPENAI_STATUS_500');
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json()).provider, 'gemini');
    assert.deepEqual(app.calls().map(call => call.provider), ['openai', 'gemini']);
    const beforeQuota = app.calls().length;
    const quota = await app.chat(app.owner, 'QUOTA_THEN_QUOTA');
    assert.equal(quota.status, 429);
    assert.deepEqual(app.calls().slice(beforeQuota).map(call => call.provider), ['openai', 'gemini']);
    const beforeAuth = app.calls().length;
    const auth = await app.chat(app.owner, 'OPENAI_STATUS_401');
    assert.equal(auth.status, 502);
    assert.deepEqual(app.calls().slice(beforeAuth).map(call => call.provider), ['openai']);
  });

  await t.test('disconnect during quota failover aborts the alternate and does not try another provider', async t => {
    const app = await startApp(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pending = app.chat(app.owner, 'QUOTA_THEN_CANCEL', { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitUntil(() => app.calls().some(call => call.provider === 'gemini'), 'Quota alternate did not start');
    controller.abort();
    await rejected;
    await waitUntil(() => app.allCalls().some(call => call.type === 'aborted' && call.provider === 'gemini'), 'Alternate did not receive cancellation');
    assert.deepEqual(app.calls().map(call => call.provider), ['openai', 'gemini']);
  });
});
