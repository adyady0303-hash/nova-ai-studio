const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('encoded coding history reaches chat and agent unchanged while invalid transport never reaches a provider', async t => {
  const root = path.join(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-message-transport-'));
  const callsPath = path.join(directory, 'calls.jsonl');
  const preloadPath = path.join(directory, 'provider.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    global.fetch = async (url, options) => {
      if (new URL(url).hostname !== 'api.openai.com') throw new Error('Unexpected destination');
      const body = JSON.parse(options.body);
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(body) + '\\n');
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'Răspuns complet' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  const portServer = net.createServer();
  await new Promise((resolve, reject) => portServer.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough',
      AI_PROVIDER: 'openai', AI_FALLBACK_PROVIDERS: '', OPENAI_API_KEY: 'fixture-not-real', OPENAI_MODEL: 'gpt-fixture' }
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let started = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    try { if ((await fetch(base + '/healthz')).ok) { started = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(started, logs);
  let cookie = '';
  const request = (route, body) => fetch(base + route, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const login = await request('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const settings = await request('/api/settings', { providerId: 'openai', routes: {
    text: 'openai', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: false
  } });
  assert.equal(settings.status, 200, await settings.text());
  const created = await request('/api/projects', { name: 'Transport test', empty: true });
  assert.equal(created.status, 201);
  const project = (await created.json()).project.id;
  const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const encode = body => ({ ...body, messagesEncoding: 'base64-utf8', messages: body.messages.map(message => ({
    ...message, content: Buffer.from(message.content, 'utf8').toString('base64')
  })) });
  const body = messages => ({ model: 'gpt-fixture', project, task: 'code', mode: 'build', messages });

  await t.test('both endpoints preserve original Unicode code and unencoded callers', async () => {
    const messages = [
      { role: 'user', content: 'Creează o pagină HTML.' },
      { role: 'assistant', content: "\ufeffAm creat <script>alert('OK')</script>. Rulează `npx serve` sau `python -m http.server`. 漢字 😀" },
      { role: 'user', content: 'Continuă scrierea fără să modifici textul anterior.' }
    ];
    for (const route of ['/api/chat', '/api/agent']) {
      for (const payload of [body(messages), encode(body(messages))]) {
        const response = await request(route, payload);
        assert.equal(response.status, 200, await response.text());
        assert.deepEqual(calls().at(-1).messages.filter(message => message.role !== 'system'), messages);
      }
    }
  });

  await t.test('unknown encodings, malformed base64 and invalid UTF-8 fail before any provider call', async () => {
    const before = calls().length;
    const malformed = [
      { messagesEncoding: 'rot13', content: 'abc' },
      { messagesEncoding: null, content: 'abc' },
      ...['not base64!', 'Zg', 'Zh==', '/w==', 'wK8=', '7aCA', null].map(content => ({ messagesEncoding: 'base64-utf8', content }))
    ];
    for (const route of ['/api/chat', '/api/agent']) {
      for (const invalid of malformed) {
        const response = await request(route, { ...body([{ role: 'user', content: invalid.content }]), messagesEncoding: invalid.messagesEncoding });
        assert.equal(response.status, 400, await response.text());
      }
    }
    assert.equal(calls().length, before);
  });

  await t.test('near-limit decoded UTF-8 works with more than one MiB on the wire and oversize content or metadata is rejected', async () => {
    const maximum = 1024 * 1024;
    const payload = body([{ role: 'user', content: '' }]);
    const budget = maximum - 1 - Buffer.byteLength(JSON.stringify(payload), 'utf8');
    payload.messages[0].content = 'ă🦉'.repeat(Math.floor(budget / 6)) + 'x'.repeat(budget % 6);
    assert.equal(Buffer.byteLength(JSON.stringify(payload), 'utf8'), maximum - 1);
    const wire = encode(payload);
    assert.ok(Buffer.byteLength(JSON.stringify(wire), 'utf8') > maximum);
    const response = await request('/api/chat', wire);
    assert.equal(response.status, 200, await response.text());
    assert.equal(calls().at(-1).messages.at(-1).content, payload.messages[0].content);
    const before = calls().length;
    for (const route of ['/api/chat', '/api/agent']) {
      const tooLarge = encode(body([{ role: 'user', content: payload.messages[0].content + 'xx' }]));
      const oversized = await request(route, tooLarge);
      assert.equal(oversized.status, 413, await oversized.text());
      const metadata = encode(body([{ role: 'user', content: '', displayContent: 'x'.repeat(maximum) }]));
      const extraMetadata = await request(route, metadata);
      assert.equal(extraMetadata.status, 413, await extraMetadata.text());
      const unencoded = await request(route, body([{ role: 'user', content: 'x'.repeat(maximum) }]));
      assert.equal(unencoded.status, 413, await unencoded.text());
    }
    assert.equal(calls().length, before);
  });
});
