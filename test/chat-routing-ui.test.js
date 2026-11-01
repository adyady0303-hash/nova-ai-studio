const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const routingHelpers = source.slice(source.indexOf('function looksLikeCvCreationRequest('), source.indexOf('function openCvBuilder('));

test('free chat and direct creation do not start the project agent', () => {
  const context = vm.createContext({});
  vm.runInContext(routingHelpers, context);

  assert.equal(context.usesDirectChat('auto'), true);
  assert.equal(context.usesDirectChat('text'), true);
  assert.equal(context.usesDirectChat('lyrics'), true);
  assert.equal(context.usesDirectChat('code'), false);
  assert.equal(context.usesDirectChat('business'), false);
});

test('the send flow routes direct chat to the chat endpoint', () => {
  const sendSource = source.slice(source.indexOf('async function send()'), source.indexOf('el("editor").addEventListener'));
  assert.match(sendSource, /const directChat = usesDirectChat\(task\)/);
  assert.match(sendSource, /directChat\s*\? await api\("\/api\/chat"/);
  assert.match(sendSource, /: await api\("\/api\/agent"/);
});
