const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('cloud status accepts every configured AI platform and shows its name', async () => {
  for (const provider of ['openai', 'gemini', 'ollama']) {
    const nodes = new Map();
    function el(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, {
          style: {}, value: '', textContent: '',
          classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
          removeAttribute() {}, replaceChildren() { this.value = ''; }, add(option) { this.value = option.value; }
        });
      }
      return nodes.get(id);
    }
    const name = { openai: 'OpenAI', gemini: 'Google Gemini', ollama: 'Ollama' }[provider];
    const context = { el, state: { settings: { platform: provider, platformName: name } },
      providerDisplayName: () => name,
      routeProfile: () => ({ textModel: 'fixture-model' }),
      fallbackNames: () => [],
      healthModels: data => data.models,
      Option: class { constructor(text, value) { this.text = text; this.value = value; } },
      api: async () => ({ connected: true, provider, providerName: name, models: ['fixture-model'], version: 'test' })
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function refreshHealth('), source.indexOf('async function loadProviderSettings(')), context);
    await context.refreshHealth();
    assert.equal(el('connectionDot').classList.contains('on'), true);
    assert.equal(el('instanceBadge').textContent, 'ONLINE · CLOUD');
    assert.match(el('connectionText').textContent, new RegExp(name));
    assert.equal(el('modelSelect').value, 'fixture-model');
  }
});
