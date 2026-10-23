const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');

const root = path.join(__dirname, '..');

test('app entry points and responsive page metadata exist', () => {
  for (const file of ['server.js', 'public/index.html', 'public/app.js', 'public/admin.html']) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(html, /<html[^>]+lang="ro"/);
  assert.match(html, /<meta[^>]+name="viewport"/);
  assert.match(html, /@media\s*\(max-width:\s*(?:620|1000)px\)/);
  assert.match(html, /id="sendBtn"/);
  assert.match(html, /id="editor"/);
  assert.match(html, /id="providerDialog"/);
  assert.match(html, /id="voiceDialog"/);
  assert.match(html, /id="generateVoiceBtn"/);
  assert.match(html, /id="voiceComposerBtn"/);
  assert.match(html, /id="editImageBtn"[^>]*>＋ Adaugă foto<\/button>/);
  assert.match(html, /id="textModel" value="gpt-5\.4"/);
  assert.match(html, /id="imageEditDialog"/);
  assert.match(html, /id="imageEditFile"/);
  assert.match(html, /id="adminDashboardLink"/);
  assert.match(html, /id="projectDrawer"/);
  assert.match(html, /id="publishProjectBtn"/);
  assert.match(html, /id="publishedSiteLink"/);
  assert.match(app, /editImageBtn"\)\.hidden = false/);
  assert.match(app, /imageEditSettingsBtn"\)\.hidden = subscriber/);
});

test('Orbit dashboard routes creation tools to implemented actions', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/studio.css'), 'utf8');
  assert.match(html, /<main class="chat home-active" id="chat">/);
  assert.match(html, /Ideile tale\.<br><span>O nouă dimensiune\.<\/span>/);
  for (const navItem of ['Acasă', 'Creează', 'Explorează', 'Proiecte']) assert.match(html, new RegExp(`>${navItem}<`));
  assert.match(html, /id="homePrompt"/);
  assert.match(html, /id="homeSendBtn"/);
  assert.match(html, /id="resumeChatBtn"/);
  for (const action of ['code', 'image', 'lyrics', 'business']) {
    assert.match(html, new RegExp(`data-home-action="${action}"`));
  }
  assert.doesNotMatch(html, /data-(?:home-action|task)="(?:music|video)"/);
  assert.match(html, /id="homeProjects"/);
  assert.match(html, /class="home-kicker"/);
  assert.match(html, /id="newProjectDialog"/);
  assert.match(app, /function renderHomeProjects\(\)/);
  assert.match(app, /slice\(0, 4\)/);
  assert.match(app, /data-create-project/);
  assert.doesNotMatch(app, /Neon Dreams|Old Beat|Band City|starterProjectNames/);
  assert.match(app, /name\.textContent = "Proiect nou"/);
  assert.match(html, /id="newHomeProjectBtn"/);
  assert.match(app, /async function saveNewProject\(name\)/);
  assert.match(app, /project-cover/);
  assert.match(app, /function submitHomePrompt\(\)/);
  assert.match(app, /api\("\/api\/agent"/);
  assert.match(app, /generateImageFromPrompt\(\)/);
  assert.match(app, /generateImageEdit\(\)/);
  assert.match(app, /\/api\/media\/image\/edit/);
  assert.match(app, /function openVoiceDialog\(\)/);
  assert.match(css, /\.chat\.home-active/);
  assert.match(css, /\.card-code\s*\{/);
  assert.match(css, /\.project-cover/);
  assert.match(css, /@media \(max-width: 480px\)/);
});

test('server uses environment-provided credentials and does not ship secrets', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /process\.env\.NOVA_ACCESS_PASSWORD/);
  assert.match(server, /process\.env\.OPENAI_API_KEY/);
  assert.match(server, /HttpOnly/);
  assert.match(server, /SameSite=Strict/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /sk-[A-Za-z0-9]{20,}/);
});

test('production defaults to OpenAI and reports a missing API key clearly', async t => {
  const dataDir = fs.mkdtempSync(path.join(root, '.nova-production-test-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      NOVA_DATA_DIR: dataDir,
      NOVA_ACCESS_USER: 'nova-test-user',
      NOVA_ACCESS_PASSWORD: 'local-test-password-at-least-20',
      AI_PROVIDER: '',
      OPENAI_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', value => { output += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output += value; });
  t.after(async () => {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => output);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'nova-test-user', password: 'local-test-password-at-least-20' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const health = await fetch(`${baseUrl}/api/health`, { headers: { cookie } });
  assert.deepEqual(await health.json(), {
    connected: false,
    provider: 'openai',
    error: 'Cheia API OpenAI lipsește din configurarea serverului.',
    models: []
  });
  const aiTest = await fetch(`${baseUrl}/api/ai/test`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1-mini' })
  });
  assert.equal(aiTest.status, 503);
  assert.deepEqual(await aiTest.json(), {
    connected: false, provider: 'openai', error: 'Cheia API OpenAI lipsește din configurarea serverului.'
  });
});

test('authenticated HTTP flows protect settings, projects, files and exports', async t => {
  const dataDir = fs.mkdtempSync(path.join(root, '.nova-http-test-'));
  const providerPort = await getFreePort();
  const fakeApiKey = 'unit-test-secret-never-return-this';
  let expectedAuthorization = `Bearer ${fakeApiKey}`;
  let mockChatModel = '';
  let mockChatPrompt = '';
  let mockChatLimit = null;
  let mockToolChoice = null;
  let mockSystemPrompt = '';
  let mockSpeechBody = null;
  let mockSpeechMode = 'audio';
  let mockImageBody = null;
  let mockImageEditBody = Buffer.alloc(0);
  const providerServer = http.createServer((req, res) => {
    if (req.headers.authorization !== expectedAuthorization) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [
        { id: 'gpt-4.1-mini' }, { id: 'gpt-6.1-mini' }, { id: 'gpt-image-1' },
        { id: 'gpt-6.1' }, { id: 'gpt-6.1-2026-10-01' }
      ] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const scriptRequest = [...body.messages].reverse().find(message =>
          message.role === 'user' && ['OWNER_SCRIPT_WRITE', 'SUBSCRIBER_SCRIPT_WRITE'].includes(message.content)
        );
        if (scriptRequest) {
          const ownerScript = scriptRequest.content === 'OWNER_SCRIPT_WRITE';
          const scriptPath = ownerScript ? 'scripts/owner-deploy.sh' : 'scripts/subscriber-deploy.sh';
          const scriptContent = ownerScript ? '#!/bin/sh\nprintf "owner\\n"\n' : '#!/usr/bin/env node\nconsole.log("subscriber");\n';
          const toolReply = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'script-write-1');
          const canWrite = body.tools?.some(tool => tool.function.name === 'write_file');
          const message = toolReply
            ? { role: 'assistant', content: 'Scriptul a fost salvat.' }
            : canWrite
              ? { role: 'assistant', content: null, tool_calls: [{ id: 'script-write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: scriptPath, content: scriptContent }) } }] }
              : { role: 'assistant', content: 'Scrierea nu este disponibilă pentru această cerere.' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message }], model: body.model }));
          return;
        }
        if (body.messages.some(message => message.role === 'user' && message.content === 'Test web loop')) {
          const canSearch = body.tools?.some(tool => tool.function.name === 'read_web_page');
          const message = canSearch
            ? { role: 'assistant', content: null, tool_calls: Array.from({ length: 4 }, (_, index) => ({ id: `web-loop-${body.messages.length}-${index}`, type: 'function', function: { name: 'read_web_page', arguments: JSON.stringify({ url: 'https://127.0.0.1/' }) } })) }
            : { role: 'assistant', content: 'Răspuns final după căutările disponibile.' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message }], model: body.model }));
          return;
        }
        if (body.messages.some(message => message.role === 'user' && message.content === 'Test web tools')) {
          assert.ok(body.tools.some(tool => tool.function.name === 'web_search'));
          assert.ok(body.tools.some(tool => tool.function.name === 'read_web_page'));
          assert.match(body.messages[0].content, /Ai acces la internet/);
          const toolReply = body.messages.find(message => message.role === 'tool');
          const message = toolReply
            ? { role: 'assistant', content: `Rezultat verificat: ${toolReply.content}` }
            : { role: 'assistant', content: null, tool_calls: [{ id: 'web-test-1', type: 'function', function: { name: 'read_web_page', arguments: JSON.stringify({ url: 'https://127.0.0.1/' }) } }] };
          if (toolReply) assert.equal(toolReply.tool_call_id, 'web-test-1');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message }], model: body.model }));
          return;
        }
        mockChatModel = body.model;
        mockChatPrompt = body.messages?.at(-1)?.content || '';
        mockChatLimit = body.max_completion_tokens || null;
        mockToolChoice = body.tool_choice || null;
        mockSystemPrompt = body.messages.find(message => message.role === 'system')?.content || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: body.messages.some(message => message.role === 'user' && message.content === 'Test missing knowledge') && !body.tool_choice ? 'Nu am informații despre acest subiect.' : 'Răspuns verificat de test.' } }], model: body.model }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        mockSpeechBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (mockSpeechMode === 'html') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html>Provider error</html>');
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(mockSpeechMode === 'empty' ? Buffer.alloc(0) : Buffer.from('fake-mp3-audio'));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        mockImageBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        mockImageEditBody = Buffer.concat(chunks);
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => providerServer.once('error', reject).listen(providerPort, '127.0.0.1', resolve));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NOVA_DATA_DIR: dataDir,
      NOVA_ACCESS_USER: 'nova-test-user',
      NOVA_ACCESS_PASSWORD: 'local-test-password-at-least-20',
      NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '2',
      AI_PROVIDER: '',
      OPENAI_API_KEY: fakeApiKey,
      OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', value => { output += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output += value; });
  t.after(async () => {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    await new Promise(resolve => providerServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => output);

  const publicVersion = await fetch(`${baseUrl}/api/version`);
  assert.equal(publicVersion.status, 200);
  const versionData = await publicVersion.json();
  assert.equal(versionData.release, 'real-project-dashboard-v2');
  assert.equal(versionData.version, require('../package.json').version);
  assert.ok(versionData.commit === null || /^[a-f0-9]{40}$/i.test(versionData.commit));
  assert.deepEqual(Object.keys(versionData).sort(), ['commit', 'release', 'version']);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const preview = await fetch(`${baseUrl}/preview-orbit`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal(preview.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(preview.headers.get('content-security-policy'), /connect-src 'none'/);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /ORBIT \/ PREVIZUALIZARE/);
  assert.match(previewHtml, /Fără apeluri AI/);
  assert.match(previewHtml, new RegExp(`name="nova-version" content="${require('../package.json').version}"`));
  assert.doesNotMatch(previewHtml, /__NOVA_VERSION__/);
  assert.doesNotMatch(previewHtml, /fetch\(|src="\/app\.js/);
  const previewHead = await fetch(`${baseUrl}/preview-orbit`, { method: 'HEAD' });
  assert.equal(previewHead.status, 200);
  assert.equal(await previewHead.text(), '');

  const loginPage = await fetch(`${baseUrl}/`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /Autentificare/);
  assert.match(loginHtml, /Creează un cont de abonat/);
  assert.match(loginHtml, /Cont fără taxă de înscriere/);
  assert.match(loginHtml, /data-password-toggle="password"/);
  assert.doesNotMatch(loginHtml, /id="confirm-password"/);
  assert.match(loginHtml, /password\.maxLength=8/);
  assert.match(loginHtml, /Fără cerințe de majuscule/);
  assert.match(loginHtml, /password\.maxLength=128/);

  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/options`)).json(), { google: false });
  assert.match(loginHtml, /id="google-login"[^>]*hidden/);
  assert.doesNotMatch(loginHtml, /__GOOGLE_LOGIN_HIDDEN__/);
  assert.equal((await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' })).status, 503);
  for (const [username, password] of [['samepass', 'samepass'], ['plain', 'x'], ['symbols', ' !@#$%^ ']]) {
    const simple = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ username, password }) });
    assert.equal(simple.status, 201, await simple.text());
    const simpleCookie = simple.headers.get('set-cookie').split(';', 1)[0];
    const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: simpleCookie } })).json();
    assert.equal(me.role, 'subscriber');
    assert.equal(me.username, username);
    const simpleLogin = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ username, password }) });
    assert.equal(simpleLogin.status, 200);
  }

  const overlongRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'subscriber-overlong', password: '123456789' })
  });
  assert.equal(overlongRegistration.status, 400);
  assert.deepEqual(await overlongRegistration.json(), {
    error: 'Parola abonatului trebuie să aibă între 1 și 8 caractere.'
  });
  assert.match(loginHtml, /Sesiunea a expirat\. Autentifică-te din nou\./);
  assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401);

  const rejectedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'wrong', password: 'wrong' })
  });
  assert.equal(rejectedLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'nova-test-user', password: 'local-test-password-at-least-20' })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';', 1)[0];
  const request = (route, options = {}) => fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { cookie, ...(options.headers || {}) }
  });
  const post = (route, value) => request(route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });

  const appPage = await request('/');
  const appHtml = await appPage.text();
  assert.match(appHtml, /Nova AI Studio/);
  const version = require('../package.json').version;
  assert.ok(appHtml.includes(`/app.js?v=${version}`));
  assert.ok(appHtml.includes(`/studio.css?v=${version}`));
  assert.ok(appHtml.includes(`/orbit.css?v=${version}`));
  assert.ok(appHtml.includes(`v${version}</span>`));
  assert.doesNotMatch(appHtml, /__NOVA_VERSION__/);
  assert.equal(appPage.headers.get('cache-control'), 'no-cache');
  const settings = await request('/api/settings');
  assert.equal(settings.status, 200);
  const settingsText = await settings.text();
  assert.match(settingsText, /"apiKeyConfigured":true/);
  assert.doesNotMatch(settingsText, new RegExp(fakeApiKey));
  const beforeInvalidSettings = await (await request('/api/settings')).json();
  for (const invalid of [
    { provider: 'openai', baseUrl: 'invalid-url', clearApiKey: true },
    { provider: 'openai', baseUrl: 'https://example.com/v1', clearApiKey: true }
  ]) {
    assert.equal((await post('/api/settings', invalid)).status, 400);
    assert.deepEqual(await (await request('/api/settings')).json(), beforeInvalidSettings);
  }
  const aiHealth = await request('/api/health');
  assert.deepEqual(await aiHealth.json(), {
    connected: true, provider: 'openai', version: 'Conexiune verificată', models: ['gpt-6.1', 'gpt-6.1-mini', 'gpt-4.1-mini']
  });
  const aiChat = await post('/api/chat', {
    model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Salut Nova' }]
  });
  assert.equal(aiChat.status, 200);
  assert.deepEqual(await aiChat.json(), {
    content: 'Răspuns verificat de test.', model: 'gpt-4.1-mini', done: true
  });
  assert.equal(mockChatModel, 'gpt-4.1-mini');
  assert.equal(mockChatPrompt, 'Salut Nova');
  assert.match(mockSystemPrompt, /Data curentă UTC este/);
  const verifiedChat = await post('/api/chat', { model: 'gpt-4.1-mini', verifyWeb: true, messages: [{ role: 'user', content: 'Care este prețul actual?' }] });
  assert.equal(verifiedChat.status, 200);
  assert.deepEqual(mockToolChoice, { type: 'function', function: { name: 'web_search' } });
  assert.match((await verifiedChat.json()).content, /nu pot fi confirmate/);


  const webChat = await post('/api/chat', {
    model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Test web tools' }]
  });
  assert.equal(webChat.status, 200);
  assert.match((await webChat.json()).content, /Rezultat verificat: Eroare:.*rezervate/);

  const aiTest = await post('/api/ai/test', { model: 'gpt-4.1-mini' });
  assert.equal(aiTest.status, 200);
  assert.deepEqual(await aiTest.json(), {
    connected: true, provider: 'openai', model: 'gpt-4.1-mini', reply: 'Răspuns verificat de test.'
  });
  assert.equal(mockChatPrompt, 'Răspunde doar cu: Nova este conectată.');
  assert.equal(mockChatLimit, 24);

  const voice = await post('/api/media/speech', { text: 'Bun venit la Nova AI Studio.' });
  assert.equal(voice.status, 200);
  const voiceResult = await voice.json();
  assert.equal(voiceResult.model, 'gpt-4o-mini-tts');
  assert.equal(voiceResult.dataUrl, `data:audio/mpeg;base64,${Buffer.from('fake-mp3-audio').toString('base64')}`);
  assert.deepEqual(mockSpeechBody, {
    model: 'gpt-4o-mini-tts', voice: 'nova', input: 'Bun venit la Nova AI Studio.', response_format: 'mp3',
    instructions: 'Vorbește clar, natural și expresiv în limba textului. Păstrează sensul și cuvintele textului. Când textul este în română, pronunță corect diacriticele și folosește pauze firești la punctuație. Recită textul; nu adăuga explicații și nu cânta.'
  });
  const chosenVoice = await post('/api/media/speech', { text: 'Citește natural acest text.', voice: 'coral', speed: 0.85 });
  assert.equal(chosenVoice.status, 200);
  assert.equal(mockSpeechBody.voice, 'coral');
  assert.equal(mockSpeechBody.speed, 0.85);
  assert.equal((await post('/api/media/speech', { text: 'Text', voice: 'unknown' })).status, 400);
  assert.equal((await post('/api/media/speech', { text: 'Text', speed: 10 })).status, 400);
  const image = await post('/api/media/image', { prompt: 'Imagine de probă Nova' });
  assert.equal(image.status, 200);
  assert.match((await image.json()).dataUrl, /^data:image\/png;base64,iVBOR/);
  assert.equal(mockImageBody.prompt, 'Imagine de probă Nova');
  assert.equal(mockImageBody.model, 'gpt-image-1');
  assert.equal(mockImageBody.size, '1024x1024');
  assert.equal(mockImageBody.quality, 'high');
  const sourcePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const editedImage = await post('/api/media/image/edit', { prompt: 'Schimbă fundalul în albastru', image: `data:image/png;base64,${sourcePng}` });
  assert.equal(editedImage.status, 200);
  const editedImageResult = await editedImage.json();
  assert.match(editedImageResult.dataUrl, /^data:image\/png;base64,iVBOR/);
  assert.equal(editedImageResult.edited, true);
  const imageEditForm = mockImageEditBody.toString('latin1');
  for (const value of ['name="model"', 'gpt-image-1', 'name="prompt"', 'filename="nova-input.png"', 'name="size"', '1024x1024', 'name="quality"', 'high']) assert.match(imageEditForm, new RegExp(value));
  assert.ok(mockImageEditBody.includes(Buffer.from('Schimbă fundalul în albastru')));
  assert.equal((await post('/api/media/image/edit', { prompt: '', image: `data:image/png;base64,${sourcePng}` })).status, 400);
  assert.equal((await post('/api/media/image/edit', { prompt: 'Test', image: 'data:text/plain;base64,dGVzdA==' })).status, 400);
  assert.equal((await post('/api/media/image/edit', { prompt: 'Test', image: 'data:image/png;base64,dGVzdA==' })).status, 400);
  const legacyVoiceSettings = await post('/api/settings', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, speechModel: 'tts-1'
  });
  assert.equal(legacyVoiceSettings.status, 200);
  assert.equal((await post('/api/media/speech', { text: 'Voce compatibilă.' })).status, 200);
  assert.equal(mockSpeechBody.model, 'tts-1');
  assert.equal(Object.hasOwn(mockSpeechBody, 'instructions'), false);
  for (const mode of ['html', 'empty']) {
    mockSpeechMode = mode;
    const invalidAudio = await post('/api/media/speech', { text: 'Test fișier invalid' });
    assert.equal(invalidAudio.status, 502);
    assert.equal(Object.hasOwn(await invalidAudio.json(), 'dataUrl'), false);
  }
  mockSpeechMode = 'audio';

  expectedAuthorization = 'Bearer valid-test-key';
  const invalidKeySettings = await post('/api/settings', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: 'invalid-test-key', textModel: 'gpt-4.1-mini'
  });
  assert.equal(invalidKeySettings.status, 200);
  const rejectedVoice = await post('/api/media/speech', { text: 'Test autentificare furnizor' });
  assert.equal(rejectedVoice.status, 401);
  assert.equal((await rejectedVoice.json()).providerError, true);
  const rejectedAiHealth = await request('/api/health');
  const rejectedAiStatus = await rejectedAiHealth.json();
  assert.equal(rejectedAiStatus.connected, false, JSON.stringify(rejectedAiStatus));
  assert.equal(rejectedAiStatus.error, 'OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render.');
  assert.doesNotMatch(JSON.stringify(rejectedAiStatus), /invalid-test-key/);
  const rejectedAiTest = await post('/api/ai/test', { model: 'gpt-4.1-mini' });
  assert.equal(rejectedAiTest.status, 502);
  const rejectedAiTestStatus = await rejectedAiTest.json();
  assert.equal(rejectedAiTestStatus.connected, false);
  assert.equal(rejectedAiTestStatus.error, 'OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render.');
  assert.doesNotMatch(JSON.stringify(rejectedAiTestStatus), /invalid-test-key/);

  const unsafeSettings = await post('/api/settings', {
    provider: 'openai', baseUrl: 'https://user:pass@example.com/v1', textModel: 'model'
  });
  assert.equal(unsafeSettings.status, 400);

  const created = await post('/api/projects', { name: 'Proiect Test Nova' });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal(project.id, 'proiect-test-nova');
  assert.equal((await post('/api/settings', { provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'valid-test-key' })).status, 200);
  for (const [task, expected] of [['text', /Scrie textul final/], ['lyrics', /strofe/], ['business', /calendar de lansare/]]) {
    const response = await post('/api/agent', { project: project.id, model: 'gpt-4.1-mini', task, mode: 'plan', messages: [{ role: 'user', content: 'Creează un exemplu complet' }] });
    assert.equal(response.status, 200);
    await response.json();
    assert.match(mockSystemPrompt, expected);
  }
  for (const task of ['music', 'video']) {
    const removed = await post('/api/agent', { project: project.id, model: 'gpt-4.1-mini', task, mode: 'plan', messages: [{ role: 'user', content: 'Creează' }] });
    assert.equal(removed.status, 410);
    assert.match((await removed.json()).error, /eliminat/);
  }
  for (const endpoint of ['/api/chat', '/api/agent']) {
    const automatic = await post(endpoint, { project: project.id, model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Care sunt ultimele noutăți online?' }] });
    assert.equal(automatic.status, 200);
    await automatic.json();
    assert.deepEqual(mockToolChoice, { type: 'function', function: { name: 'web_search' } });
  }
  for (const endpoint of ['/api/chat', '/api/agent']) {
    const retried = await post(endpoint, { project: project.id, model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Test missing knowledge' }] });
    assert.equal(retried.status, 200);
    assert.match((await retried.json()).content, /nu pot fi confirmate/);
    assert.deepEqual(mockToolChoice, { type: 'function', function: { name: 'web_search' } });
  }
  const verifiedAgent = await post('/api/agent', { project: project.id, model: 'gpt-4.1-mini', verifyWeb: true, messages: [{ role: 'user', content: 'Verifică o informație publică actuală' }] });
  assert.equal(verifiedAgent.status, 200);
  assert.deepEqual(mockToolChoice, { type: 'function', function: { name: 'web_search' } });
  assert.match((await verifiedAgent.json()).content, /nu pot fi confirmate/);
  const projects = await request('/api/projects');
  const listedProject = (await projects.json()).projects.find(item => item.id === project.id);
  assert.equal(listedProject.fileCount, 3);
  assert.match(listedProject.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const initialFiles = await request(`/api/files?project=${project.id}`);
  assert.deepEqual((await initialFiles.json()).files.map(file => file.path).sort(), ['README.md', 'package.json', 'src/index.js'].sort());

  const ownerWrite = await post('/api/agent', {
    project: project.id, model: 'gpt-4.1-mini', mode: 'build', allowChanges: false,
    messages: [{ role: 'user', content: 'OWNER_SCRIPT_WRITE' }]
  });
  assert.equal(ownerWrite.status, 200);
  assert.ok((await ownerWrite.json()).events.some(event => event.tool === 'write_file' && event.ok));
  const ownerScript = await request(`/api/file?project=${project.id}&path=scripts%2Fowner-deploy.sh`);
  assert.equal(ownerScript.status, 200);
  assert.equal((await ownerScript.json()).content, '#!/bin/sh\nprintf "owner\\n"\n');
  assert.equal((await post('/api/settings', { provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'invalid-test-key' })).status, 200);

  const write = await request('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: project.id, path: 'src/generated.js', content: 'export const answer = 42;\n' })
  });
  assert.equal(write.status, 200);
  assert.equal((await write.json()).action, 'created');
  const read = await request(`/api/file?project=${project.id}&path=src%2Fgenerated.js`);
  assert.equal((await read.json()).content, 'export const answer = 42;\n');

  assert.deepEqual(await (await request(`/api/project/publication?project=${project.id}`)).json(), { published: false });
  const missingHomePage = await post('/api/project/publish', { project: project.id });
  assert.equal(missingHomePage.status, 400);
  assert.match((await missingHomePage.json()).error, /index\.html/);
  for (const [filePath, content] of [
    ['index.html', '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Afacere publicată</h1></body></html>'],
    ['styles.css', 'body { color: navy; }']
  ]) {
    assert.equal((await request('/api/file', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: project.id, path: filePath, content })
    })).status, 200);
  }
  const published = await post('/api/project/publish', { project: project.id });
  assert.equal(published.status, 200);
  const publication = await published.json();
  assert.match(publication.url, /^\/p\/[a-f0-9]{24}\/$/);
  const publicPage = await fetch(`${baseUrl}${publication.url}`);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /Afacere publicată/);
  assert.match(publicPage.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.doesNotMatch(publicPage.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal((await fetch(`${baseUrl}${publication.url}styles.css`)).status, 200);
  assert.equal((await fetch(`${baseUrl}${publication.url}%2e%2e%2fserver.js`)).status, 403);
  assert.equal((await post('/api/project/unpublish', { project: project.id })).status, 200);
  assert.equal((await fetch(`${baseUrl}${publication.url}`)).status, 404);
  const republished = await (await post('/api/project/publish', { project: project.id })).json();
  assert.match(republished.url, /^\/p\/[a-f0-9]{24}\/$/);

  const traversal = await request('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: project.id, path: '../outside.txt', content: 'blocked' })
  });
  assert.equal(traversal.status, 400);

  const exported = await request(`/api/project/export?project=${project.id}`);
  assert.equal(exported.status, 200);
  const bundle = await exported.json();
  assert.equal(bundle.format, 'nova-project');
  assert.ok(bundle.files.some(file => file.path === 'src/generated.js' && file.content.includes('42')));

  const deleted = await request(`/api/file?project=${project.id}&path=src%2Fgenerated.js`, { method: 'DELETE' });
  const deleteBody = await deleted.text();
  assert.equal(deleted.status, 200, `${deleteBody}\n${output}`);
  const undo = await post('/api/undo', { project: project.id, path: 'src/generated.js' });
  assert.equal(undo.status, 200);
  const restoredFile = await request(`/api/file?project=${project.id}&path=src%2Fgenerated.js`);
  assert.equal((await restoredFile.json()).content, 'export const answer = 42;\n');

  const renamed = await post('/api/project/rename', { project: project.id, name: 'Proiect Redenumit' });
  assert.equal((await renamed.json()).name, 'Proiect Redenumit');
  const trashed = await post('/api/project/delete', { project: project.id });
  assert.equal(trashed.status, 200);
  assert.equal((await fetch(`${baseUrl}${republished.url}`)).status, 404);
  assert.ok((await (await request('/api/projects/trash')).json()).projects.some(item => item.id === project.id));
  const restored = await post('/api/project/restore', { project: project.id });
  assert.equal(restored.status, 200);
  assert.ok((await (await request('/api/projects')).json()).projects.some(item => item.id === project.id));

  const emptyImage = await post('/api/media/image', { prompt: '' });
  assert.equal(emptyImage.status, 400);
  const emptySpeech = await post('/api/media/speech', { text: '' });
  assert.equal(emptySpeech.status, 400);
  assert.equal((await post('/api/settings', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'valid-test-key'
  })).status, 200);
  const webAgent = await post('/api/agent', {
    project: project.id, model: 'gpt-4.1-mini', mode: 'plan', messages: [{ role: 'user', content: 'Test web tools' }]
  });
  assert.equal(webAgent.status, 200);
  const webAgentResult = await webAgent.json();
  assert.match(webAgentResult.content, /Rezultat verificat: Eroare:.*rezervate/);
  assert.deepEqual(webAgentResult.events, []);
  const boundedWebAgent = await post('/api/agent', {
    project: project.id, model: 'gpt-4.1-mini', mode: 'plan', messages: [{ role: 'user', content: 'Test web loop' }]
  });
  assert.equal(boundedWebAgent.status, 200);
  const boundedWebResult = await boundedWebAgent.json();
  assert.match(boundedWebResult.content, /Răspuns final după căutările disponibile/);
  assert.deepEqual(boundedWebResult.events, []);
  assert.equal((await post('/api/settings', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'invalid-test-key'
  })).status, 200);

  const invalidAgent = await post('/api/agent', { project: project.id, messages: [{ role: 'user', content: 'test' }] });
  assert.equal(invalidAgent.status, 400);

  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/projects')).status, 401);
  assert.equal((await request('/api/web/health')).status, 401);

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'subscriber-one', password: 'pass1234' })
  });
  assert.equal(registration.status, 201, await registration.text());
  const tooLongSubscriberPassword = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'subscriber-two', password: '123456789' })
  });
  assert.equal(tooLongSubscriberPassword.status, 400);
  assert.deepEqual(await tooLongSubscriberPassword.json(), {
    error: 'Parola abonatului trebuie să aibă între 1 și 8 caractere.'
  });
  const subscriberCookie = registration.headers.get('set-cookie').split(';', 1)[0];
  const subscriberRequest = (route, options = {}) => fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { cookie: subscriberCookie, ...(options.headers || {}) }
  });
  const subscriberPost = (route, value) => subscriberRequest(route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  const subscriberAccount = await (await subscriberRequest('/api/auth/me')).json();
  assert.equal(subscriberAccount.role, 'subscriber');
  assert.equal(subscriberAccount.username, 'subscriber-one');
  assert.equal(subscriberAccount.dailyLimit, 2);
  assert.equal((await (await subscriberRequest('/api/projects')).json()).projects.length, 0);

  const duplicateRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'SUBSCRIBER-ONE', password: 'pass1234' })
  });
  assert.equal(duplicateRegistration.status, 409);
  const reservedRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'nova-test-user', password: 'pass1234' })
  });
  assert.equal(reservedRegistration.status, 409);

  const adminPage = await fetch(`${baseUrl}/admin.html`, { headers: { cookie: subscriberCookie }, redirect: 'manual' });
  assert.equal(adminPage.status, 302);
  const deniedSettings = await subscriberPost('/api/settings', { provider: 'openai' });
  assert.equal(deniedSettings.status, 403);
  const privateProjectResponse = await subscriberPost('/api/projects', { name: 'Spațiu Privat' });
  assert.equal(privateProjectResponse.status, 201);
  const privateProject = (await privateProjectResponse.json()).project;
  assert.equal((await subscriberRequest('/api/web/health')).status, 403);
  assert.equal((await subscriberRequest(`/api/files?project=${project.id}`)).status, 404);
  assert.ok((await (await subscriberRequest('/api/projects')).json()).projects.some(item => item.id === privateProject.id));

  assert.equal((await subscriberPost('/api/ai/test', { model: 'gpt-4.1-mini' })).status, 502);
  assert.equal((await subscriberPost('/api/ai/test', { model: 'gpt-4.1-mini' })).status, 502);
  assert.equal((await subscriberPost('/api/ai/test', { model: 'gpt-4.1-mini' })).status, 429);

  assert.equal((await subscriberRequest('/api/auth/logout', { method: 'POST' })).status, 200);
  const subscriberLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'subscriber-one', password: 'pass1234' })
  });
  assert.equal(subscriberLogin.status, 200);
  const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'nova-test-user', password: 'local-test-password-at-least-20' })
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';', 1)[0];
  const ownerProjects = await (await fetch(`${baseUrl}/api/projects`, { headers: { cookie: ownerCookie } })).json();
  assert.ok(ownerProjects.projects.some(item => item.id === project.id));
  assert.ok(!ownerProjects.projects.some(item => item.id === privateProject.id));

  const ownerPost = (route, value) => fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  assert.equal((await ownerPost('/api/settings', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'valid-test-key'
  })).status, 200);
  const mediaRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'media-subscriber', password: 'media123' })
  });
  assert.equal(mediaRegistration.status, 201);
  const mediaCookie = mediaRegistration.headers.get('set-cookie').split(';', 1)[0];
  const mediaPost = (route, value) => fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { cookie: mediaCookie, 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  const subscriberImage = await mediaPost('/api/media/image', { prompt: 'Imagine disponibilă abonatului' });
  assert.equal(subscriberImage.status, 200);
  assert.equal(subscriberImage.headers.get('x-nova-ai-remaining'), '1');
  const subscriberImageEdit = await mediaPost('/api/media/image/edit', { prompt: 'Schimbă fundalul', image: `data:image/png;base64,${sourcePng}` });
  assert.equal(subscriberImageEdit.status, 200);
  assert.equal(subscriberImageEdit.headers.get('x-nova-ai-remaining'), '0');
  const writerRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ username: 'writer-subscriber', password: 'write123' })
  });
  assert.equal(writerRegistration.status, 201);
  const writerCookie = writerRegistration.headers.get('set-cookie').split(';', 1)[0];
  const writerRequest = (route, options = {}) => fetch(`${baseUrl}${route}`, {
    ...options, headers: { cookie: writerCookie, ...(options.headers || {}) }
  });
  const writerPost = (route, value) => writerRequest(route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
  const writerProjectResponse = await writerPost('/api/projects', { name: 'Reguli Abonat' });
  assert.equal(writerProjectResponse.status, 201);
  const writerProject = (await writerProjectResponse.json()).project;
  assert.equal((await writerRequest('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: writerProject.id, path: 'index.html', content: '<!doctype html><title>Site abonat</title><h1>Online</h1>' })
  })).status, 200);
  const subscriberPublication = await writerPost('/api/project/publish', { project: writerProject.id });
  assert.equal(subscriberPublication.status, 200);
  const subscriberPublicUrl = (await subscriberPublication.json()).url;
  assert.match(await (await fetch(`${baseUrl}${subscriberPublicUrl}`)).text(), /Site abonat/);
  const blockedSubscriberWrite = await writerPost('/api/agent', {
    project: writerProject.id, model: 'gpt-4.1-mini', mode: 'build', allowChanges: false,
    messages: [{ role: 'user', content: 'SUBSCRIBER_SCRIPT_WRITE' }]
  });
  assert.equal(blockedSubscriberWrite.status, 200);
  assert.ok(!(await blockedSubscriberWrite.json()).events.some(event => event.tool === 'write_file'));
  const filesAfterBlockedWrite = await (await writerRequest(`/api/files?project=${writerProject.id}`)).json();
  assert.ok(!filesAfterBlockedWrite.files.some(file => file.path === 'scripts/subscriber-deploy.sh'));
  const allowedSubscriberWrite = await writerPost('/api/agent', {
    project: writerProject.id, model: 'gpt-4.1-mini', mode: 'build', allowChanges: true,
    messages: [{ role: 'user', content: 'SUBSCRIBER_SCRIPT_WRITE' }]
  });
  assert.equal(allowedSubscriberWrite.status, 200);
  assert.ok((await allowedSubscriberWrite.json()).events.some(event => event.tool === 'write_file' && event.ok));
  const subscriberScript = await writerRequest(`/api/file?project=${writerProject.id}&path=scripts%2Fsubscriber-deploy.sh`);
  assert.equal(subscriberScript.status, 200);
  assert.equal((await subscriberScript.json()).content, '#!/usr/bin/env node\nconsole.log("subscriber");\n');
});

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child, getOutput) {
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Nova failed to start:\n${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Nova did not start in time: ${lastError?.message || 'unknown error'}\n${getOutput()}`);
}

