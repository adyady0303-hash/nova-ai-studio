const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const secretMarker = 'sk-fixture-private-diagnostic-marker';
const rawMarker = 'PRIVATE_PROVIDER_DIAGNOSTIC';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('provider diagnostics distinguish Gemini transport, HTTP and response failures without exposing secrets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-provider-diagnostics-'));
  const controlPath = path.join(directory, 'provider-scenario.txt');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  fs.writeFileSync(controlPath, 'success');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const controlPath = ${JSON.stringify(controlPath)};
    const privateDetail = ${JSON.stringify(`${rawMarker} ${secretMarker} https://fixture-user:fixture-password@private.example/internal?key=${secretMarker} /srv/private/credential-file`)};
    function reply(status, payload, raw = false) {
      const text = raw ? payload : JSON.stringify(payload);
      return { status, ok: status >= 200 && status < 300,
        headers: { get: () => 'application/json' }, text: async () => text,
        json: async () => JSON.parse(text) };
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'generativelanguage.googleapis.com') throw new Error('Unexpected provider host');
      if (parsed.pathname.endsWith('/models')) return reply(200, { data: [{ id: 'models/gemini-2.5-flash' }] });
      if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('Unexpected provider path');
      const scenario = fs.readFileSync(controlPath, 'utf8');
      if (['dns', 'tls', 'network', 'timeout'].includes(scenario)) {
        const codes = { dns: 'ENOTFOUND', tls: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', network: 'ECONNRESET', timeout: 'UND_ERR_CONNECT_TIMEOUT' };
        const cause = Object.assign(new Error(privateDetail), { code: codes[scenario] });
        throw new TypeError(privateDetail, { cause });
      }
      if (scenario === 'http503') return reply(503, { error: { message: privateDetail, code: privateDetail, status: 'UNAVAILABLE' } });
      if (scenario === 'null-json') return reply(200, null);
      if (scenario === 'inband-error') return reply(200, { error: { code: 503, message: privateDetail } });
      if (scenario === 'body-interrupted') return { status:200,ok:true,text:async()=>{throw new TypeError(privateDetail,{cause:Object.assign(new Error(privateDetail),{code:'UND_ERR_SOCKET'})});} };
      if (scenario === 'invalid-json') return reply(200, privateDetail, true);
      if (scenario === 'missing-message') return reply(200, { choices: [], diagnostic: privateDetail });
      const body = JSON.parse(options.body);
      return reply(200, { choices: [{ message: { role: 'assistant', content: 'Nova este conectată.' } }], model: body.model });
    };
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough',
      NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5', AI_PROVIDER: 'gemini', AI_FALLBACK_PROVIDERS: '',
      GEMINI_API_KEY: secretMarker, GEMINI_MODEL: 'gemini-2.5-flash',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '',
      MISTRAL_API_KEY: '', DEEPSEEK_API_KEY: '', XAI_API_KEY: '', TOGETHER_API_KEY: '', CUSTOM_OPENAI_API_KEY: ''
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
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(base + '/healthz')).ok) { started = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(started, logs);

  function request(cookie) {
    return (route, body) => fetch(base + route, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  const login = await request('')('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  const owner = request(login.headers.get('set-cookie').split(';', 1)[0]);
  async function projectFor(client, name) {
    const response = await client('/api/projects', { name, empty: true });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).project.id;
  }
  const ownerProject = await projectFor(owner, 'Diagnostic workspace');
  const routes = ['/api/chat', '/api/agent', '/api/ai/test'];
  function bodyFor(project) {
    return { model: 'gemini-2.5-flash', project, task: 'text', messages: [{ role: 'user', content: 'Salut' }] };
  }
  function assertSanitized(body, serialized) {
    for (const forbidden of [secretMarker, rawMarker, 'fixture-user', 'fixture-password', 'private.example', '/srv/private/credential-file']) {
      assert.ok(!serialized.includes(forbidden), `Diagnostic response exposed ${forbidden}`);
    }
    for (const property of ['details', 'cause', 'stack', 'headers', 'requestHeaders', 'apiKey', 'raw', 'responseBody']) {
      assert.equal(body[property], undefined, `Diagnostic response exposed ${property}`);
    }
  }
  async function expectFailure(client, project, route, scenario, pattern, chatStatus) {
    fs.writeFileSync(controlPath, scenario);
    const response = await client(route, bodyFor(project));
    const serialized = await response.text();
    const body = JSON.parse(serialized);
    const expectedStatus = route === '/api/chat' ? chatStatus : route === '/api/agent' ? 503 : 502;
    assert.equal(response.status, expectedStatus, serialized);
    assert.match(body.error, /Gemini/i);
    assert.match(body.error, pattern, `${route}: ${serialized}`);
    if (route === '/api/ai/test') assert.equal(body.connected, false);
    else assert.equal(body.providerError, true);
    assertSanitized(body, serialized);
    return body;
  }

  const scenarios = [
    ['dns', /DNS|rezolv.*adres/i, 502],
    ['tls', /TLS|certificat/i, 502],
    ['network', /rețea|contact|conect/i, 502],
    ['timeout', /expirat|timeout|timp/i, 504],
    ['http503', /HTTP\s*503/i, 503],
    ['null-json', /răspuns.*(?:invalid|incompatibil)/i, 502],
    ['inband-error', /cod 503/i, 503],
    ['body-interrupted', /conexiune|contact/i, 502],
    ['invalid-json', /JSON|răspuns.*(?:invalid|nevalid)|format.*(?:invalid|nevalid)/i, 502],
    ['missing-message', /răspuns.*(?:invalid|nevalid)|mesaj.*(?:invalid|nevalid)|format.*(?:invalid|nevalid)/i, 502]
  ];
  for (const [scenario, pattern, chatStatus] of scenarios) {
    await t.test(`${scenario} is classified and sanitized consistently across chat, agent and connection test`, async () => {
      for (const route of routes) await expectFailure(owner, ownerProject, route, scenario, pattern, chatStatus);
    });
  }

  await t.test('subscriber failures expose safe categories without raw or owner-only diagnostic objects', async () => {
    const registration = await request('')('/api/auth/register', { username: 'diagnostic-visitor', password: 'pass1234' });
    assert.equal(registration.status, 201);
    const visitor = request(registration.headers.get('set-cookie').split(';', 1)[0]);
    const visitorProject = await projectFor(visitor, 'Visitor diagnostic workspace');
    for (const [route, scenario, pattern, chatStatus] of [
      ['/api/chat', 'dns', /DNS|rezolv.*adres/i, 502],
      ['/api/agent', 'tls', /TLS|certificat/i, 502],
      ['/api/ai/test', 'http503', /HTTP\s*503/i, 503]
    ]) {
      const body = await expectFailure(visitor, visitorProject, route, scenario, pattern, chatStatus);
      assert.equal(body.diagnostics, undefined);
      assert.equal(body.diagnostic, undefined);
    }
  });

  await t.test('successful Gemini requests still return model and provider attribution', async () => {
    fs.writeFileSync(controlPath, 'success');
    for (const route of routes) {
      const response = await owner(route, bodyFor(ownerProject));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.provider, 'gemini');
      assert.equal(body.model, 'gemini-2.5-flash');
      if (route === '/api/ai/test') assert.equal(body.connected, true);
      else assert.match(body.content, /Nova este conectată/);
    }
  });
});
