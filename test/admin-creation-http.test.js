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

test('administrator creation has no Nova quotas while subscriber limits remain enforced', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-admin-creation-'));
  const callsPath = path.join(directory, 'calls.jsonl');
  const preloadPath = path.join(directory, 'provider-mock.cjs');
  fs.writeFileSync(callsPath, '');
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    const callsPath = ${JSON.stringify(callsPath)};
    const record = value => fs.appendFileSync(callsPath, JSON.stringify(value) + '\\n');
    const web = require(${JSON.stringify(path.join(root, 'web-tools.js'))});
    web.callWebTool = async (name, args) => {
      record({ type: 'web', name, args });
      return 'Public source: https://example.com/article';
    };
    function reply(data) {
      const body = JSON.stringify(data);
      return { status: 200, ok: true, headers: { get: () => 'application/json' },
        text: async () => body, json: async () => data };
    }
    function tool(id, name, args) {
      return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    }
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'api.openai.com') throw new Error('Unexpected provider: ' + parsed.hostname);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      if (parsed.pathname.endsWith('/models')) {
        return reply({ data: ['gpt-admin-test', 'gpt-image-1.5'].map(id => ({ id })) });
      }
      if (parsed.pathname.endsWith('/images/generations') || parsed.pathname.endsWith('/images/edits')) {
        record({ type: 'image', path: parsed.pathname, prompt: body?.prompt ?? options.body.get('prompt') });
        return reply({ data: [{ b64_json: 'aW1hZ2U=' }] });
      }
      if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('Unexpected route: ' + parsed.pathname);
      record({ type: 'chat', ...body });
      const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      if (prompt.startsWith('WAIT_CANCEL_')) {
        return new Promise((resolve, reject) => {
          const cancel = () => {
            record({ type: 'aborted', prompt });
            reject(options.signal.reason || new DOMException('Aborted', 'AbortError'));
          };
          if (options.signal?.aborted) cancel();
          else options.signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      const rounds = body.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length).length;
      let message = { role: 'assistant', content: 'Creation complete.' };
      if (prompt === 'AGENT_LOOP' && rounds < 9 && body.tools?.some(item => item.function.name === 'write_file')) {
        message = { role: 'assistant', content: null, tool_calls: Array.from({ length: 6 }, (_, index) =>
          tool('write-' + rounds + '-' + index, 'write_file', {
            path: 'generated/round-' + rounds + '-file-' + index + '.txt', content: 'Created ' + rounds + ':' + index
          })) };
      }
      if (prompt === 'READ_LARGE_FILE' && !body.messages.some(message => message.role === 'tool')) {
        message = { role: 'assistant', content: null, tool_calls: [tool('large-read', 'read_file', { path: 'large.txt' })] };
      }
      if (prompt === 'WEB_LOOP' && rounds < 5 && body.tools?.some(item => item.function.name === 'read_web_page')) {
        message = { role: 'assistant', content: null, tool_calls: Array.from({ length: 2 }, (_, index) =>
          tool('web-' + rounds + '-' + index, 'read_web_page', { url: 'https://example.com/article' })) };
      }
      return reply({ choices: [{ message }], model: body.model });
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
      OPENAI_API_KEY: 'test-key-not-real', OPENAI_MODEL: 'gpt-admin-test', OPENAI_IMAGE_MODEL: 'gpt-image-1.5'
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
    return (route, body, method = 'POST', options = {}) => fetch(base + route, {
      ...options,
      method, headers: { cookie, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  const login = await request('')('/api/auth/login', { username: 'owner', password: 'owner-password-long-enough' });
  assert.equal(login.status, 200);
  const owner = request(login.headers.get('set-cookie').split(';', 1)[0]);
  const settings = await owner('/api/settings', {
    providerId: 'openai', routes: { text: 'openai', image: 'openai', speech: 'openai', autoSelect: false, autoFallback: false }
  });
  assert.equal(settings.status, 200, await settings.text());
  const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const chatBody = content => ({ model: 'gpt-admin-test', messages: [{ role: 'user', content }] });
  async function subscriber(name) {
    const response = await request('')('/api/auth/register', { username: name, password: 'pass1234' });
    assert.equal(response.status, 201, await response.text());
    return request(response.headers.get('set-cookie').split(';', 1)[0]);
  }
  async function createProject(client, name) {
    const response = await client('/api/projects', { name, empty: true });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).project;
  }
  const project = await createProject(owner, 'Owner work');

  await t.test('owner can create more than ten projects and exceed the subscriber AI allowance', async () => {
    for (let index = 0; index < 11; index++) await createProject(owner, `Owner project ${index}`);
    const projects = await (await owner('/api/projects', undefined, 'GET')).json();
    assert.equal(projects.projects.length, 12);
    for (let index = 0; index < 7; index++) {
      const response = await owner('/api/chat', chatBody(`OWNER_REQUEST_${index}`));
      assert.equal(response.status, 200, await response.text());
      assert.equal(response.headers.get('x-nova-ai-remaining'), null);
    }
    const me = await (await owner('/api/auth/me', undefined, 'GET')).json();
    assert.equal(me.role, 'owner');
    assert.equal(me.dailyLimit, null);
    assert.equal(me.remainingToday, null);

    const visitor = await subscriber('quota-visitor');
    for (let index = 0; index < 10; index++) await createProject(visitor, `Visitor project ${index}`);
    assert.equal((await visitor('/api/projects', { name: 'Eleventh project' })).status, 403);
    for (let index = 0; index < 5; index++) {
      assert.equal((await visitor('/api/chat', chatBody(`VISITOR_REQUEST_${index}`))).status, 200);
    }
    assert.equal((await visitor('/api/chat', chatBody('OVER_QUOTA'))).status, 429);
    assert.equal((await owner('/api/chat', chatBody('OWNER_AFTER_SUBSCRIBER_EXHAUSTED'))).status, 200);
  });

  await t.test('owner chat and agent receive full history and long messages; subscribers retain input bounds', async () => {
    const messages = Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: index === 12 ? 'INPUTS_' + 'x'.repeat(30000) + '_END' : `History ${index}`
    }));
    for (const route of ['/api/chat', '/api/agent']) {
      const response = await owner(route, { model: 'gpt-admin-test', project: project.id, task: 'code', messages });
      assert.equal(response.status, 200, await response.text());
      const sent = calls().filter(call => call.type === 'chat').at(-1).messages.filter(item => item.role !== 'system');
      assert.equal(sent.length, messages.length);
      assert.deepEqual(sent.map(item => item.content.length), messages.map(item => item.content.length));
      assert.ok(sent.every((item, index) => item.role === messages[index].role && item.content === messages[index].content));
    }
    const visitor = await subscriber('input-visitor');
    const visitorProject = await createProject(visitor, 'Visitor input');
    for (const route of ['/api/chat', '/api/agent']) {
      const response = await visitor(route, { model: 'gpt-admin-test', project: visitorProject.id, messages });
      assert.equal(response.status, 200, await response.text());
      const sent = calls().filter(call => call.type === 'chat').at(-1).messages.filter(item => item.role !== 'system');
      assert.equal(sent.length, 6);
      assert.equal(sent.at(-1).content.length, 6000);
    }
  });

  await t.test('owner agent finishes nine rounds and six writes per round while subscriber limits remain', async () => {
    const response = await owner('/api/agent', { ...chatBody('AGENT_LOOP'), project: project.id, task: 'code' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.events.length, 54);
    assert.deepEqual(result.events.map(event => event.path), Array.from({length: 54}, (_, index) => `generated/round-${Math.floor(index / 6)}-file-${index % 6}.txt`));
    assert.ok(result.events.every(event => event.ok), JSON.stringify(result.events.filter(event => !event.ok)));
    const finalFile = await owner(`/api/file?project=${project.id}&path=generated/round-8-file-5.txt`, undefined, 'GET');
    assert.equal(finalFile.status, 200);
    assert.equal((await finalFile.json()).content, 'Created 8:5');

    const visitor = await subscriber('tools-visitor');
    const visitorProject = await createProject(visitor, 'Visitor tools');
    const limited = await visitor('/api/agent', { ...chatBody('AGENT_LOOP'), project: visitorProject.id, task: 'code', allowChanges: true });
    assert.equal(limited.status, 200);
    const limitedResult = await limited.json();
    assert.equal(limitedResult.events.filter(event => event.ok).length, 16);
    assert.equal(limitedResult.events.filter(event => !event.ok).length, 8);
    const visitorFiles = await (await visitor(`/api/files?project=${visitorProject.id}`, undefined, 'GET')).json();
    assert.ok(!visitorFiles.files.some(file => file.path === 'generated/round-4-file-0.txt'));
    assert.ok(!visitorFiles.files.some(file => file.path === 'generated/round-0-file-4.txt'));
    const created = await visitor(`/api/file?project=${visitorProject.id}&path=generated/round-3-file-3.txt`, undefined, 'GET');
    assert.equal(created.status, 200);
    assert.equal((await created.json()).content, 'Created 3:3');
  });

  await t.test('owner agent sees complete file tool output beyond thirty thousand characters', async () => {
    const content = 'a'.repeat(40000) + 'IMPORTANT_END';
    assert.equal((await owner('/api/file', { project: project.id, path: 'large.txt', content }, 'PUT')).status, 200);
    const response = await owner('/api/agent', { ...chatBody('READ_LARGE_FILE'), project: project.id, task: 'code' });
    assert.equal(response.status, 200, await response.text());
    const sent = calls().filter(call => call.type === 'chat').at(-1).messages;
    const toolContent = sent.find(message => message.tool_call_id === 'large-read').content;
    assert.equal(toolContent.length, content.length);
    assert.ok(toolContent === content);
  });

  await t.test('owner media prompts reach the provider intact and subscriber prompts retain their bound', async () => {
    const prompt = 'Imagine ' + 'p'.repeat(5000) + '_END';
    const source = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const visitor = await subscriber('image-visitor');
    for (const route of ['/api/media/image', '/api/media/image/edit']) {
      const response = await owner(route, { prompt, image: source });
      assert.equal(response.status, 200, await response.text());
      const sentPrompt = calls().filter(call => call.type === 'image').at(-1).prompt;
      assert.equal(sentPrompt.length, prompt.length);
      assert.ok(sentPrompt === prompt);
      const limited = await visitor(route, { prompt, image: source });
      assert.equal(limited.status, 200, await limited.text());
      assert.equal(calls().filter(call => call.type === 'image').at(-1).prompt, prompt.slice(0, 4000));
    }
  });

  await t.test('owner chat can complete more than four web rounds and six web calls', async () => {
    const before = calls().filter(call => call.type === 'web').length;
    const response = await owner('/api/chat', chatBody('WEB_LOOP'));
    assert.equal(response.status, 200, await response.text());
    assert.equal(calls().filter(call => call.type === 'web').length - before, 10);
    const visitor = await subscriber('web-visitor');
    const beforeVisitor = calls().filter(call => call.type === 'web').length;
    const limited = await visitor('/api/chat', chatBody('WEB_LOOP'));
    assert.equal(limited.status, 200, await limited.text());
    assert.equal(calls().filter(call => call.type === 'web').length - beforeVisitor, 4);
  });

  await t.test('disconnecting owner chat or agent cancels the in-flight provider call', async t => {
    async function waitUntil(predicate, description) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(description);
    }
    for (const route of ['/api/chat', '/api/agent']) {
      const marker = `WAIT_CANCEL_${route}`;
      const controller = new AbortController();
      t.after(() => controller.abort());
      const response = owner(route, { ...chatBody(marker), project: project.id, task: 'code' }, 'POST', { signal: controller.signal });
      const rejected = assert.rejects(response, { name: 'AbortError' });
      await waitUntil(() => calls().some(call => call.type === 'chat' && call.messages.some(message => message.content === marker)), 'Provider call did not start');
      controller.abort();
      await rejected;
      await waitUntil(() => calls().some(call => call.type === 'aborted' && call.prompt === marker), 'Provider call did not receive cancellation');
      assert.equal(calls().filter(call => call.type === 'chat' && call.messages.some(message => message.content === marker)).length, 1);
    }
  });

  await t.test('a business model refusing file tools fails promptly instead of retrying forever', async () => {
    const response = await owner('/api/agent', {
      ...chatBody('BUSINESS_REFUSAL'), project: project.id, task: 'business', mode: 'build'
    }, 'POST', { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 503, await response.text());
    assert.equal(calls().filter(call => call.type === 'chat' && call.messages.some(message => message.content === 'BUSINESS_REFUSAL')).length, 2);
  });
});
