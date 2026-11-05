const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const context = vm.createContext({ TextEncoder, btoa });
vm.runInContext(source.slice(source.indexOf('function encodeMessageContent('), source.indexOf('function toast(')), context);

test('chat serializer transports complete UTF-8 code history without exposing code as JSON field text', () => {
  const content = "\ufeffÎncearcă `npx serve` sau `python -m http.server`\n<script>alert('OK');</script>\n漢字 😀 𝄞 " + 'Scriere lungă 🦉\n'.repeat(9000);
  const value = { project: 'test', model: 'gemini-fixture', mode: 'build', messages: [
    { role: 'user', content, displayContent: 'Preview only' },
    { role: 'assistant', content: 'Am creat index.html.' },
    { role: 'user', content: '' }
  ] };
  const original = JSON.stringify(value);
  const result = context.jsonBody(value);
  const payload = JSON.parse(result.body);
  assert.equal(result.method, 'POST');
  assert.equal(result.headers['content-type'], 'application/json');
  assert.equal(payload.messagesEncoding, 'base64-utf8');
  assert.equal(payload.project, value.project);
  assert.equal(payload.model, value.model);
  assert.equal(payload.mode, value.mode);
  assert.equal(payload.messages[0].displayContent, value.messages[0].displayContent);
  assert.equal(/npx serve|python -m http\.server|<script>/.test(result.body), false);
  payload.messages.forEach((message, index) => {
    assert.equal(message.role, value.messages[index].role);
    assert.equal(Buffer.from(message.content, 'base64').toString('utf8'), value.messages[index].content);
  });
  assert.equal(JSON.stringify(value), original, 'serialization cannot mutate visible history');
});

test('settings and other JSON requests retain their existing payload', () => {
  const value = { providerId: 'gemini', textModel: 'gemini-fixture', prompt: 'Un text normal' };
  assert.deepEqual(JSON.parse(context.jsonBody(value).body), value);
});
