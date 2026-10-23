const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('an upstream AI authentication failure does not log the visitor out of Nova', async () => {
  let redirects = 0, providerError = true;
  const context = { state: { account: null }, window: { location: { replace() { redirects++; } } },
    fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'Rejected', providerError }) }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('function jsonBody(')), context);
  await assert.rejects(context.api('/api/media/speech'));
  assert.equal(redirects, 0);
  providerError = false;
  await assert.rejects(context.api('/api/auth/me'));
  assert.equal(redirects, 1);
});

test('image failure restores the prompt without overwriting a new draft', async () => {
  for (const newerDraft of ['', 'Un alt prompt']) {
    const nodes = { prompt: { value: 'Imaginea mea' }, generateImageBtn: { disabled: false } };
    const context = {
      el: id => nodes[id], setView() {}, addBubble() {}, resizePrompt() {}, jsonBody: value => value,
      document: { createElement: () => ({ remove() {} }) }, messageContainer: () => ({ append() {} }),
      api: async () => { nodes.prompt.value = newerDraft; throw Error('Provider failed'); }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function generateImageFromPrompt('), source.indexOf('function selectedImageEditFile(')), context);
    await context.generateImageFromPrompt();
    assert.equal(nodes.prompt.value, newerDraft || 'Imaginea mea');
    assert.equal(nodes.generateImageBtn.disabled, false);
  }
});

test('voice sends the full supported text and rejects oversized lyrics without calling the provider', async () => {
  const calls = [];
  const context = { api: async (route, body) => { calls.push(body); return {}; }, jsonBody: value => value };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function generateSpeech('), source.indexOf('function updateVoiceCost(')), context);
  await context.generateSpeech('a'.repeat(4096));
  assert.equal(calls[0].text.length, 4096);
  await assert.rejects(context.generateSpeech('a'.repeat(4097)), /4096/);
  assert.equal(calls.length, 1);
});
