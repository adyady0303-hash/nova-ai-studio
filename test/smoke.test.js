const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const root = path.join(__dirname, '..');

test('app entry points and responsive page metadata exist', () => {
  for (const file of ['server.js', 'public/index.html', 'public/app.js', 'public/admin.html']) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
  }
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /<html[^>]+lang="ro"/);
  assert.match(html, /<meta[^>]+name="viewport"/);
  assert.match(html, /@media\s*\(max-width:\s*(?:620|1000)px\)/);
  assert.match(html, /id="sendBtn"/);
  assert.match(html, /id="editor"/);
  assert.match(html, /id="providerDialog"/);
  assert.match(html, /id="adminDashboardLink"/);
  assert.match(html, /id="projectDrawer"/);
});

test('server uses environment-provided credentials and does not ship secrets', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /process\.env\.NOVA_ACCESS_PASSWORD/);
  assert.match(server, /process\.env\.OPENAI_API_KEY/);
  assert.match(server, /HttpOnly/);
  assert.match(server, /SameSite=Strict/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /sk-[A-Za-z0-9]{20,}/);
});

test('authenticated HTTP flows protect settings, projects, files and exports', async t => {
  const dataDir = fs.mkdtempSync(path.join(root, '.nova-http-test-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fakeApiKey = 'unit-test-secret-never-return-this';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NOVA_DATA_DIR: dataDir,
      NOVA_ACCESS_USER: 'nova-test-user',
      NOVA_ACCESS_PASSWORD: 'local-test-password-at-least-20',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: fakeApiKey
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

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const loginPage = await fetch(`${baseUrl}/`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Autentificare/);
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
  assert.match(await appPage.text(), /Nova AI Studio/);
  const settings = await request('/api/settings');
  assert.equal(settings.status, 200);
  const settingsText = await settings.text();
  assert.match(settingsText, /"apiKeyConfigured":true/);
  assert.doesNotMatch(settingsText, new RegExp(fakeApiKey));
  const aiHealth = await request('/api/health');
  assert.deepEqual(await aiHealth.json(), {
    connected: true, provider: 'openai', version: 'API configurat', models: ['gpt-4.1-mini']
  });

  const unsafeSettings = await post('/api/settings', {
    provider: 'openai', baseUrl: 'https://user:pass@example.com/v1', textModel: 'model'
  });
  assert.equal(unsafeSettings.status, 400);

  const created = await post('/api/projects', { name: 'Proiect Test Nova' });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal(project.id, 'proiect-test-nova');
  const projects = await request('/api/projects');
  assert.ok((await projects.json()).projects.some(item => item.id === project.id));

  const initialFiles = await request(`/api/files?project=${project.id}`);
  assert.deepEqual((await initialFiles.json()).files.map(file => file.path).sort(), ['README.md', 'package.json', 'src/index.js'].sort());

  const write = await request('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: project.id, path: 'src/generated.js', content: 'export const answer = 42;\n' })
  });
  assert.equal(write.status, 200);
  assert.equal((await write.json()).action, 'created');
  const read = await request(`/api/file?project=${project.id}&path=src%2Fgenerated.js`);
  assert.equal((await read.json()).content, 'export const answer = 42;\n');

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
  assert.ok((await (await request('/api/projects/trash')).json()).projects.some(item => item.id === project.id));
  const restored = await post('/api/project/restore', { project: project.id });
  assert.equal(restored.status, 200);
  assert.ok((await (await request('/api/projects')).json()).projects.some(item => item.id === project.id));

  const emptyImage = await post('/api/media/image', { prompt: '' });
  assert.equal(emptyImage.status, 400);
  const emptySpeech = await post('/api/media/speech', { text: '' });
  assert.equal(emptySpeech.status, 400);
  const invalidAgent = await post('/api/agent', { project: project.id, messages: [{ role: 'user', content: 'test' }] });
  assert.equal(invalidAgent.status, 400);

  const logout = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/projects')).status, 401);
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
  throw new Error(`Nova did not start in time: ${lastError?.message || getOutput()}`);
}

