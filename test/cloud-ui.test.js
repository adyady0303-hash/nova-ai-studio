const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('cloud status never reports a legacy provider as a verified cloud connection', async () => {
  for (const provider of ['openai', 'ollama']) {
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
    const context = { el, state: { settings: { provider } },
      Option: class { constructor(text, value) { this.text = text; this.value = value; } },
      api: async () => ({ connected: true, provider, models: ['fixture-model'], version: 'test' })
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function refreshHealth('), source.indexOf('async function loadProviderSettings(')), context);
    await context.refreshHealth();
    assert.equal(el('connectionDot').classList.contains('on'), provider === 'openai');
    assert.equal(el('instanceBadge').textContent, 'ONLINE · CLOUD');
    assert.doesNotMatch(el('connectionText').textContent + el('sidebarConnectionText').textContent, /ollama|local/i);
    if (provider === 'ollama') assert.equal(el('modelSelect').value, '');
    else assert.equal(el('modelSelect').value, 'fixture-model');
  }
});
