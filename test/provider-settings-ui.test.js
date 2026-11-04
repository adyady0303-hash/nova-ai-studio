const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
function element() {
  const classes = new Set();
  return {
    value: '', textContent: '', style: {}, hidden: false, disabled: false, checked: false, children: [],
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; },
    add(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; }
  };
}
function profile(id, extra = {}) {
  return { id, name: id, configured: true, ready: { text: true }, textRoutingEligible: true,
    apiKeyConfigured: true, textModel: `${id}-saved`, capabilities: { text: true }, ...extra };
}
function uiContext(role = 'owner') {
  const nodes = new Map(), requests = [], copied = [];
  const el = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const profiles = [profile('openai'), profile('gemini'), profile('ollama', { apiKeyConfigured: false, textRoutingEligible: false })];
  const context = vm.createContext({
    state: { account: { role, username: 'nova' }, settings: { platform: 'openai', providers: profiles, routes: { text: 'openai' } }, projects: [] },
    el, providerNames: { openai: 'OpenAI', gemini: 'Gemini', ollama: 'Ollama' },
    providerDraftDirty: false, searchDraftDirty: false, editingProviderId: 'openai', editingSearchProvider: '',
    providerDiagnosticReport: null, providerModelRequest: 0, providerCatalogModels: [],
    document: { createElement: element },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    jsonBody: value => ({ method: 'POST', body: JSON.stringify(value) }),
    updateAccountLabel() {},
    api: async (url, options) => { requests.push({ url, options }); return {}; }
  });
  for (const [start, end] of [
    ['function providerProfiles(', 'async function refreshHealth('],
    ['function renderProviderProfile(', 'function renderRouteOptions('],
    ['function unsavedAiDraft(', 'async function testWebConnection('],
    ['function providerMonogram(', 'function renderDashboardProjects('],
    ['function renderDashboardUsage(', 'function renderProjects('],
    ['async function loadAccount(', 'function providerProfiles(']
  ]) vm.runInContext(section(start, end), context);
  context.renderProviderProfile('openai');
  return { context, el, profiles, requests, copied };
}
function report(providers = [{ id: 'openai', name: 'OpenAI', configured: true, eligible: true,
  status: { state: 'quota', checkedAt: '2026-11-04T20:00:00.000Z', model: 'openai-saved', error: 'Cotă API epuizată.' } }]) {
  return { version: '2.7.4', commit: 'test-commit', providers };
}

test('dashboard counts configured routing candidates, excludes default Ollama, and distinguishes observed status', () => {
  const { context, el, profiles } = uiContext();
  profiles[0].status = { state: 'quota', error: 'Cotă API' };
  profiles[1].status = { state: 'available', checkedAt: '2026-11-04T20:00:00.000Z' };
  profiles[2].status = { state: 'available' };
  context.renderDashboardProviders();
  const rows = el('providerRail').children;
  assert.equal(rows[0].children[2].textContent, 'Cotă API');
  assert.equal(rows[1].children[2].textContent, 'Disponibil');
  assert.match(rows[1].children[2].title, /Ultima verificare/);
  assert.equal(rows[2].children[2].textContent, 'Local · neselectat');
  assert.match(rows[2].children[2].className, /off/);
  assert.equal(el('dashboardModelTabs').children.length, 2);
  assert.equal(el('railUsage').children[0].children[2].textContent, '2');
  delete profiles[1].status;
  context.renderDashboardProviders();
  assert.equal(el('providerRail').children[1].children[2].textContent, 'Configurat · neverificat');
});

test('legacy profiles count keyless Ollama only when the owner selected it', () => {
  const { context, el, profiles } = uiContext();
  delete profiles[2].textRoutingEligible;
  context.renderDashboardUsage();
  assert.equal(el('railUsage').children[0].children[2].textContent, '2');
  context.state.settings.routes.text = 'ollama';
  context.renderDashboardUsage();
  assert.equal(el('railUsage').children[0].children[2].textContent, '3');
});

test('diagnostics use saved profiles and preserve keys and model edits typed while the request is pending', async () => {
  const { context, el, profiles, requests, copied } = uiContext();
  let resolve;
  context.api = async (url, options) => { requests.push({ url, options }); return new Promise(done => { resolve = done; }); };
  const pending = context.runProviderDiagnostics();
  assert.equal(el('runProviderDiagnostics').disabled, true);
  assert.equal(requests[0].url, '/api/ai/diagnostics');
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  el('apiKey').value = 'unsaved-private-key';
  el('textModel').value = 'new-manual-model';
  context.providerDraftDirty = true;
  const data = report();
  data.apiKey = 'top-secret'; data.providers[0].apiKey = 'profile-secret';
  data.providers[0].status.debug = { authorization: 'Bearer debug-secret' };
  resolve(data);
  await pending;
  assert.equal(el('apiKey').value, 'unsaved-private-key');
  assert.equal(el('textModel').value, 'new-manual-model');
  assert.equal(context.providerDraftDirty, true);
  assert.equal(profiles[0].status.state, 'quota');
  assert.equal(el('runProviderDiagnostics').disabled, false);
  assert.equal(el('copyProviderReport').disabled, false);
  await context.copyProviderReport();
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0], /secret|private-key|authorization|apiKey|debug/);
  assert.deepEqual(JSON.parse(copied[0]), report());
});

test('report sanitization ignores extra credential fields and objects nested in timestamp values', async () => {
  const { context, copied } = uiContext();
  const data = report();
  data.providers.unshift(null);
  data.providers[1].status.checkedAt = { apiKey: 'nested-secret' };
  context.api = async () => data;
  await context.runProviderDiagnostics();
  await context.copyProviderReport();
  const result = JSON.parse(copied[0]);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].status.checkedAt, null);
  assert.doesNotMatch(copied[0], /nested-secret|apiKey/);
});

test('checks require saving drafts and never send an unsaved provider or search key', async () => {
  for (const draft of ['provider', 'search', 'apiKey', 'searchApiKey']) {
    const { context, el, requests } = uiContext();
    if (draft === 'provider') context.providerDraftDirty = true;
    else if (draft === 'search') context.searchDraftDirty = true;
    else el(draft).value = 'draft-secret';
    await context.runProviderDiagnostics();
    await context.loadSavedProviderModels();
    assert.equal(requests.length, 0);
    assert.match(el('providerDiagnosticsNotice').textContent, /Salvează/);
    assert.match(el('providerModelsStatus').textContent, /Salvează/);
    if (draft.endsWith('Key')) assert.equal(el(draft).value, 'draft-secret');
  }
});

test('subscriber cannot call owner diagnostics or model catalogs and has no settings entry point', async () => {
  const { context, el, requests } = uiContext('subscriber');
  await context.runProviderDiagnostics();
  await context.loadSavedProviderModels();
  assert.equal(requests.length, 0);
  context.api = async () => ({ role: 'subscriber', username: 'ana' });
  await context.loadAccount();
  assert.equal(el('providerSettingsBtn').hidden, true);
  assert.equal(el('adminDashboardLink').hidden, true);
  context.api = async () => ({ role: 'owner', username: 'nova' });
  await context.loadAccount();
  assert.equal(el('providerSettingsBtn').hidden, false);
});

test('failed diagnostics restore the check control and do not offer a nonexistent report', async () => {
  const { context, el, copied } = uiContext();
  context.api = async () => { throw new Error('Serviciu indisponibil'); };
  await context.runProviderDiagnostics();
  assert.equal(el('runProviderDiagnostics').disabled, false);
  assert.equal(el('copyProviderReport').disabled, true);
  assert.match(el('providerDiagnosticsNotice').textContent, /Serviciu indisponibil/);
  await context.copyProviderReport();
  assert.equal(copied.length, 0);
});

test('a report for old saved settings does not overwrite status after the profile has been saved again', async () => {
  const { context, profiles } = uiContext();
  let resolve;
  context.api = async () => new Promise(done => { resolve = done; });
  const pending = context.runProviderDiagnostics();
  context.state.settings = { ...context.state.settings, providers: [profile('openai', { textModel: 'new-saved-model', status: { state: 'unchecked' } })] };
  resolve(report());
  await pending;
  assert.equal(context.state.settings.providers[0].status.state, 'unchecked');
  assert.equal(profiles[0].status, undefined);
});

test('catalog selection changes the draft only after an explicit choice and requires saving before testing', async () => {
  const { context, el, requests } = uiContext();
  context.api = async (url, options) => { requests.push({ url, options }); return { provider: 'openai', models: ['openai-saved', 'model-next', 'model-next'], configuredModel: 'openai-saved', recommendedModel: 'model-next' }; };
  await context.loadSavedProviderModels();
  assert.equal(requests[0].url, '/api/ai/models?provider=openai');
  assert.equal(requests[0].options, undefined);
  assert.equal(el('textModel').value, 'openai-saved');
  assert.equal(context.providerDraftDirty, false);
  assert.equal(el('providerModelCatalog').children.length, 3);
  el('providerModelCatalog').value = 'model-next';
  context.chooseProviderModel();
  assert.equal(el('textModel').value, 'model-next');
  assert.equal(context.providerDraftDirty, true);
  await context.runProviderDiagnostics();
  assert.equal(requests.length, 1);
  assert.match(el('providerDiagnosticsNotice').textContent, /Salvează/);
});

test('model catalog completion preserves a newer model or key draft and ignores a switched profile', async () => {
  for (const change of ['model', 'key', 'profile']) {
    const { context, el } = uiContext();
    let resolve;
    context.api = async () => new Promise(done => { resolve = done; });
    const pending = context.loadSavedProviderModels();
    if (change === 'profile') context.renderProviderProfile('gemini');
    else if (change === 'key') el('apiKey').value = 'new-private-key';
    else { el('textModel').value = 'typed-model'; context.providerDraftDirty = true; }
    resolve({ models: ['stale-model'], configuredModel: 'stale-model' });
    await pending;
    assert.equal(el('providerModelCatalog').disabled, true);
    assert.equal(el('loadProviderModels').disabled, false);
    assert.equal(el('textModel').value, change === 'profile' ? 'gemini-saved' : change === 'model' ? 'typed-model' : 'openai-saved');
    if (change === 'key') assert.equal(el('apiKey').value, 'new-private-key');
  }
});

test('empty or failed catalogs preserve the saved input and allow another attempt', async () => {
  const { context, el } = uiContext();
  context.api = async () => ({ models: [], configuredModel: 'openai-saved' });
  await context.loadSavedProviderModels();
  assert.equal(el('providerModelCatalog').disabled, true);
  assert.equal(el('textModel').value, 'openai-saved');
  assert.match(el('providerModelsStatus').textContent, /nu a returnat modele/);
  context.api = async () => { throw new Error('Catalog indisponibil'); };
  await context.loadSavedProviderModels();
  assert.equal(el('loadProviderModels').disabled, false);
  assert.equal(el('textModel').value, 'openai-saved');
  assert.match(el('providerModelsStatus').textContent, /Catalog indisponibil/);
});
