const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('app entry points exist', () => {
  for (const file of ['server.js', 'public/index.html', 'public/app.js']) {
    assert.ok(fs.statSync(path.join(__dirname, '..', file)).isFile(), file);
  }
});

test('dashboard loads app script and accessible page metadata', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  assert.match(html, /<html[^>]+lang="ro"/);
  assert.match(html, /<meta[^>]+name="viewport"/);
  assert.match(html, /app\.js/);
});

test('server uses environment-provided credentials and secrets', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /process\.env\.NOVA_ACCESS_PASSWORD/);
  assert.match(server, /process\.env\.OPENAI_API_KEY/);
});
