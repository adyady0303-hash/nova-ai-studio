const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

for (const authenticated of [true, false]) {
  test(`AI configuration survives a disk-backed restart ${authenticated ? 'with authentication' : 'with a generated local encryption key'}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ai-persistence-'));
    const apiKey = 'fixture-api-key-not-a-real-credential';
    const provider = http.createServer((req, res) => {
      res.writeHead(req.headers.authorization === `Bearer ${apiKey}` ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    let child;
    async function stop() {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
    }
    t.after(async () => {
      await stop(); await new Promise(resolve => provider.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    async function start() {
      child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory,
          DATABASE_URL: '', NOVA_DATA_ENCRYPTION_KEY: '', AI_PROVIDER: 'ollama', OPENAI_API_KEY: '',
          NOVA_ACCESS_USER: authenticated ? 'owner' : '', NOVA_ACCESS_PASSWORD: authenticated ? 'fixture-owner-password-long-enough' : '' }
      });
      child.stdout.resume(); child.stderr.resume();
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(ready, 'Server must start');
      if (!authenticated) return '';
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'fixture-owner-password-long-enough' }) });
      assert.equal(login.status, 200);
      return login.headers.get('set-cookie').split(';')[0];
    }
    let cookie = await start();
    const request = (route, body) => fetch(base + route, { headers: { cookie, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const saved = await request('/api/settings', { provider: 'openai', apiKey, baseUrl: endpoint, textModel: 'fixture-model' });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), new RegExp(apiKey));
    const settingsPath = path.join(directory, 'data', 'ai-settings.json');
    const encrypted = fs.readFileSync(settingsPath, 'utf8');
    assert(!encrypted.includes(apiKey), 'The credential must never be stored in plaintext');
    assert(JSON.parse(encrypted).apiKeyCipher);
    assert.equal(fs.statSync(settingsPath).mode & 0o077, 0);
    if (!authenticated) assert.equal(fs.statSync(path.join(directory, 'data', 'ai-settings.key')).mode & 0o077, 0);
    await stop(); cookie = await start();
    const settings = await (await request('/api/settings')).json();
    assert.equal(settings.settings.provider, 'openai');
    assert.equal(settings.settings.textModel, 'fixture-model');
    assert.equal(settings.settings.apiKeyConfigured, true);
    assert.equal((await (await request('/api/health')).json()).connected, true);
    const preserved = await request('/api/settings', { provider: 'openai', baseUrl: endpoint, textModel: 'fixture-model', apiKey: '' });
    assert.equal(preserved.status, 200);
    assert.equal((await (await request('/api/health')).json()).connected, true);
    // A failed disk save must not replace the working credential in memory.
    fs.unlinkSync(settingsPath); fs.mkdirSync(settingsPath);
    const failed = await request('/api/settings', { provider: 'openai', baseUrl: endpoint, apiKey: 'rejected-replacement-key' });
    assert.equal(failed.status, 500);
    assert.equal((await (await request('/api/health')).json()).connected, true);
  });
}
