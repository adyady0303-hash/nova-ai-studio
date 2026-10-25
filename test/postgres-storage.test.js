const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const baseDatabaseUrl = process.env.NOVA_TEST_DATABASE_URL;

test('PostgreSQL storage imports disk data and shares projects, sessions and settings between instances', {
  skip: !baseDatabaseUrl && 'Set NOVA_TEST_DATABASE_URL to run PostgreSQL integration coverage.'
}, async t => {
  const schema = `nova_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: baseDatabaseUrl, max: 1 });
  const dbUrl = new URL(baseDatabaseUrl);
  dbUrl.searchParams.set('options', `-c search_path=${schema}`);
  const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ha-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ha-b-'))];
  const children = [];

  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    for (const child of children) await stopServer(child);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const subscriberPassword = 'oldpass8';
  const salt = crypto.randomBytes(16).toString('base64url');
  const passwordHash = crypto.scryptSync(subscriberPassword, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }).toString('base64');
  const legacyProject = path.join(roots[0], 'projects', 'legacy-project');
  fs.mkdirSync(path.join(legacyProject, 'src'), { recursive: true });
  fs.writeFileSync(path.join(legacyProject, '.nova-project.json'), JSON.stringify({ name: 'Legacy project' }));
  fs.writeFileSync(path.join(legacyProject, 'src', 'index.js'), 'export const state = "from disk";\n');
  const accountsFile = path.join(roots[0], 'data', 'subscriber-accounts.json');
  fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
  fs.writeFileSync(accountsFile, JSON.stringify({ version: 1, users: [{
    id: crypto.randomBytes(16).toString('hex'), username: 'legacy-user', usernameKey: 'legacy-user', salt,
    passwordHash, usageDate: '', usageCount: 0, createdAt: new Date().toISOString()
  }] }));

  const serverA = await startServer(roots[0], dbUrl.toString());
  children.push(serverA);
  const serverB = await startServer(roots[1], dbUrl.toString());
  children.push(serverB);

  const owner = await post(serverA, '/api/auth/login', { username: 'nova-owner', password: 'owner-password-long-enough-123' });
  assert.equal(owner.response.status, 200, owner.body);
  const ownerCookie = owner.cookie;

  const imported = await get(serverB, '/api/projects', ownerCookie);
  assert.equal(imported.response.status, 200, imported.body);
  assert.equal(imported.body.projects.length, 1);
  assert.equal(imported.body.projects[0].id, 'legacy-project');
  assert.equal(imported.body.projects[0].name, 'Legacy project');
  assert.equal(imported.body.projects[0].fileCount, 1);
  assert.ok(Number.isFinite(Date.parse(imported.body.projects[0].updatedAt)));
  const importedFile = await get(serverB, '/api/file?project=legacy-project&path=src%2Findex.js', ownerCookie);
  assert.equal(importedFile.body.content, 'export const state = "from disk";\n');

  const changed = await request(serverA, '/api/file', ownerCookie, {
    method: 'PUT', body: { project: 'legacy-project', path: 'src/index.js', content: 'export const state = "shared";\n' }
  });
  assert.equal(changed.response.status, 200, changed.body);
  const sharedFile = await get(serverB, '/api/file?project=legacy-project&path=src%2Findex.js', ownerCookie);
  assert.equal(sharedFile.body.content, 'export const state = "shared";\n');

  const legacyLogin = await post(serverB, '/api/auth/login', { username: 'legacy-user', password: subscriberPassword });
  assert.equal(legacyLogin.response.status, 200, legacyLogin.body);
  const legacyAccount = await get(serverA, '/api/auth/me', legacyLogin.cookie);
  assert.equal(legacyAccount.body.username, 'legacy-user');

  const registration = await post(serverA, '/api/auth/register', { username: 'shared-user', password: 'share123' });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
  const sharedSession = await get(serverB, '/api/auth/me', registration.cookie);
  assert.equal(sharedSession.body.username, 'shared-user');

  const savedSettings = await request(serverA, '/api/settings', ownerCookie, {
    method: 'POST', body: {
      provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key-encrypted',
      textModel: 'gpt-4.1-mini', imageModel: 'gpt-image-1-mini', speechModel: 'gpt-4o-mini-tts', voice: 'nova'
    }
  });
  assert.equal(savedSettings.response.status, 200, savedSettings.body);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const settingsFromOtherInstance = await get(serverB, '/api/settings', ownerCookie);
  assert.equal(settingsFromOtherInstance.body.settings.provider, 'openai');
  assert.equal(settingsFromOtherInstance.body.settings.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(settingsFromOtherInstance.body), /test-key-encrypted/);
});

async function startServer(dataDir, databaseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', NOVA_DATA_DIR: dataDir,
      NOVA_ACCESS_USER: 'nova-owner', NOVA_ACCESS_PASSWORD: 'owner-password-long-enough-123',
      NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '3', AI_PROVIDER: 'ollama', DATABASE_URL: databaseUrl,
      OLLAMA_URL: 'http://127.0.0.1:11434', OPENAI_API_KEY: '', NOVA_DATA_ENCRYPTION_KEY: 'nova-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', value => { output += value; });
  child.stderr.setEncoding('utf8').on('data', value => { output += value; });
  child.output = () => output;
  child.baseUrl = `http://127.0.0.1:${port}`;
  try { await waitForServer(child); }
  catch (error) { await stopServer(child); throw error; }
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Nova failed to start:\n${child.output()}`);
    try {
      const response = await fetch(`${child.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Nova did not start in time: ${lastError?.message || 'unknown error'}\n${child.output()}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
}

async function request(server, route, cookie, { method = 'GET', body } = {}) {
  const response = await fetch(`${server.baseUrl}${route}`, {
    method,
    headers: {
      cookie,
      origin: server.baseUrl,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { result = { text }; }
  return { response, body: result };
}

async function post(server, route, body) {
  const result = await request(server, route, '', { method: 'POST', body });
  return { ...result, cookie: result.response.headers.get('set-cookie')?.split(';', 1)[0] || '' };
}

async function get(server, route, cookie) { return request(server, route, cookie); }

