const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

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

async function startApp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-media-lifecycle-'));
  const callsPath = path.join(directory, 'calls.jsonl');
  const preload = path.join(directory, 'media-mock.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const record = value => fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({...value, at: Date.now()}) + '\\n');
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => originalTimeout(milliseconds >= 200000 ? 1000 : milliseconds);
    const reply = (status, payload) => new Response(JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});
    const waitForAbort = (signal, info) => new Promise((resolve, reject) => {
      const cancel = () => { record({...info, type: 'aborted', reason: signal.reason?.name}); reject(signal.reason); };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, {once: true});
    });
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'api.openai.com') throw new Error('Unexpected media destination');
      if (parsed.pathname.endsWith('/models')) return reply(200, {data: [{id: 'fixture-text'}, {id: 'gpt-image-missing'}]});
      const editing = parsed.pathname.endsWith('/images/edits');
      if (!editing && !parsed.pathname.endsWith('/images/generations')) throw new Error('Unexpected media route');
      const body = editing ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body);
      const info = {operation: editing ? 'edit' : 'generate', model: body.model, prompt: body.prompt};
      record({...info, type: 'start', responseFormat: body.response_format, quality: body.quality});
      if (body.prompt.startsWith('DISCONNECT')) return waitForAbort(options.signal, info);
      if (body.prompt.startsWith('DEADLINE')) {
        if (body.model === 'gpt-image-missing') {
          await new Promise(resolve => setTimeout(resolve, 650));
          record({...info, type: 'missing'});
          return reply(404, {error: {message: 'The model gpt-image-missing does not exist.'}});
        }
        return waitForAbort(options.signal, info);
      }
      if (body.prompt === 'LEGACY_IMAGE') {
        if (body.response_format === 'b64_json') return reply(200, {data: [{b64_json: ${JSON.stringify(png)}}]});
        return reply(200, {data: [{url: 'https://images.example.test/temporary-output.png?expires=soon'}]});
      }
      return reply(200, {data: [{b64_json: ${JSON.stringify(png)}}]});
    };
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory, DATABASE_URL: '',
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'fixture-owner-password',
      AI_PROVIDER: 'openai', AI_FALLBACK_PROVIDERS: '',
      OPENAI_API_KEY: 'fixture-openai-key', OPENAI_MODEL: 'fixture-text', OPENAI_IMAGE_MODEL: 'gpt-image-missing',
      GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '', MISTRAL_API_KEY: '',
      DEEPSEEK_API_KEY: '', XAI_API_KEY: '', TOGETHER_API_KEY: '', CUSTOM_OPENAI_API_KEY: ''
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, {recursive: true, force: true});
  });
  await waitUntil(async () => {
    if (child.exitCode !== null) assert.fail(logs);
    try { return (await fetch(base + '/healthz')).ok; } catch { return false; }
  }, 'Media fixture server did not start');
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: {origin: base, 'content-type': 'application/json'},
    body: JSON.stringify({username: 'owner', password: 'fixture-owner-password'})
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const request = (route, body, signal) => fetch(base + route, {
    method: 'POST', headers: {cookie, origin: base, 'content-type': 'application/json'},
    body: JSON.stringify(body), ...(signal ? {signal} : {})
  });
  const records = prompt => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    .filter(call => call.prompt === prompt);
  return {request, records};
}

test('image operations share a deadline, stop on disconnect and return durable legacy output', async t => {
  const app = await startApp(t);
  for (const [operation, route] of [['generate', '/api/media/image'], ['edit', '/api/media/image/edit']]) {
    await t.test(operation + ' stops upstream work when the client disconnects', async () => {
      const prompt = 'DISCONNECT_' + operation;
      const controller = new AbortController();
      const pending = app.request(route, {prompt, image: 'data:image/png;base64,' + png}, controller.signal);
      const rejected = assert.rejects(pending, {name: 'AbortError'});
      await waitUntil(() => app.records(prompt).some(call => call.type === 'start'), 'Image provider was not called');
      controller.abort();
      await rejected;
      await waitUntil(() => app.records(prompt).some(call => call.type === 'aborted'), 'Client cancellation did not reach the image provider');
      const attempts = app.records(prompt);
      assert.equal(attempts.filter(call => call.type === 'start').length, 1, 'cancelled work must not try another model');
      const start = attempts.find(call => call.type === 'start');
      const abort = attempts.find(call => call.type === 'aborted');
      assert.ok(abort.at - start.at < 700, 'the disconnect must abort upstream before its own 1000ms deadline');
    });

    await t.test(operation + ' fallback uses the remaining operation deadline', async () => {
      const prompt = 'DEADLINE_' + operation;
      const response = await app.request(route, {prompt, image: 'data:image/png;base64,' + png}, AbortSignal.timeout(3000));
      const body = await response.json();
      assert.equal(response.status, 504, JSON.stringify(body));
      const calls = app.records(prompt);
      const starts = calls.filter(call => call.type === 'start');
      assert.deepEqual(starts.map(call => call.model), ['gpt-image-missing', 'gpt-image-1.5']);
      const aborted = calls.find(call => call.type === 'aborted');
      assert.ok(aborted, 'the stalled fallback must receive deadline cancellation');
      assert.ok(aborted.at - starts[1].at < 700, 'fallback must not get a fresh 1000ms timeout after the first 650ms attempt');
    });
  }

  for (const model of ['dall-e-2', 'dall-e-3']) {
    await t.test(model + ' generation requests durable image bytes', async () => {
      const settings = await app.request('/api/settings', {
        providerId: 'openai', imageModel: model,
        routes: {text: 'openai', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: false}
      });
      assert.equal(settings.status, 200, await settings.text());
      const response = await app.request('/api/media/image', {prompt: 'LEGACY_IMAGE'});
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert.equal(body.model, model);
      assert.equal(body.dataUrl, 'data:image/png;base64,' + png, 'history must receive bytes rather than a temporary URL');
      const sent = app.records('LEGACY_IMAGE').at(-1);
      assert.equal(sent.responseFormat, 'b64_json');
    });
  }
});
