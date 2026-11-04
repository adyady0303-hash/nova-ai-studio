const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function healthContext(provider, response) {
    const nodes = new Map();
    function el(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, {
          style: {}, value: '', textContent: '',
          classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
          removeAttribute() {}, replaceChildren(...options) { this.value = options[0]?.value || ''; }, add(option) { this.value = option.value; }
        });
      }
      return nodes.get(id);
    }
    const name = { openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama' }[provider];
    const profile = { id: provider, name, configured: true, ready: { text: true }, textRoutingEligible: true, textModel: 'fixture-model' };
    const context = { el, state: { settings: { platform: provider, platformName: name, providers: [profile] } },
      providerNames: {}, renderDashboardProviders() {},
      Option: class { constructor(text, value) { this.text = text; this.value = value; } },
      api: async () => ({ connected: true, provider, providerName: name, models: ['fixture-model'], version: 'test', ...response })
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function providerProfiles('), source.indexOf('function updateCapabilityControls(')), context);
    return { context, el, profile };
}

test('catalog access identifies every configured platform without claiming its chat works', async () => {
  for (const provider of ['openai', 'gemini', 'ollama']) {
    const { context, el } = healthContext(provider);
    await context.refreshHealth();
    assert.equal(el('connectionDot').classList.contains('on'), false);
    assert.equal(el('instanceBadge').textContent, 'ONLINE · CLOUD');
    assert.match(el('connectionText').textContent, new RegExp(context.state.settings.platformName));
    assert.match(el('statusBadge').textContent, /Catalog accesibil · chat neverificat/);
    assert.equal(el('modelSelect').value, 'fixture-model');
  }
});

test('recent completion success turns on chat status and omission clears stale settings observations', async () => {
  const status = { state: 'available', checkedAt: '2026-11-04T20:00:00.000Z', model: 'fixture-model', error: '' };
  const { context, el, profile } = healthContext('gemini', { chatStatus: status });
  await context.refreshHealth();
  assert.equal(el('connectionDot').classList.contains('on'), true);
  assert.equal(el('sidebarConnectionDot').classList.contains('on'), true);
  assert.equal(el('statusBadge').textContent, 'Disponibil');
  assert.match(el('statusBadge').title, /fixture-model.*Ultima verificare/);
  assert.equal(profile.status, status);

  context.api = async () => ({ connected: true, provider: 'gemini', models: ['fixture-model'] });
  await context.refreshHealth();
  assert.equal(el('connectionDot').classList.contains('on'), false);
  assert.match(el('statusBadge').textContent, /chat neverificat/);
  assert.equal(profile.status.state, 'unchecked');
});

test('catalog access keeps actual quota and server errors visible and preserves the saved model', async () => {
  for (const [state, label] of [['quota', 'Cotă API'], ['unavailable', 'Indisponibil']]) {
    const { context, el } = healthContext('gemini', { chatStatus: { state, model: 'fixture-model', error: 'Explicația furnizorului' }, recommendedModel: 'catalog-first', models: ['catalog-first', 'fixture-model'] });
    await context.refreshHealth();
    assert.equal(el('connectionDot').classList.contains('on'), false);
    assert.equal(el('statusBadge').textContent, label);
    assert.match(el('statusBadge').title, /Explicația furnizorului/);
    assert.equal(el('modelSelect').value, 'fixture-model');
  }
});

test('catalog failure does not erase a recent successful chat observation', async () => {
  const { context, el } = healthContext('gemini', { connected: false, error: 'Catalog indisponibil', chatStatus: { state: 'available', model: 'fixture-model' } });
  await context.refreshHealth();
  assert.equal(el('connectionDot').classList.contains('on'), true);
  assert.equal(el('modelSelect').value, 'fixture-model');
});
