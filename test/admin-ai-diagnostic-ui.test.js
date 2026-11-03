const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+refresh\(\);\s*$/, '\n');

function element() {
  return {
    textContent: '', className: '', disabled: false, value: '', children: [], listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; }
  };
}

function diagnosticContext({ settings, health } = {}) {
  const nodes = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(id, element());
  const requests = [], redirects = [];
  const fixtures = {
    settings: settings ?? { platform: 'gemini', platformName: 'Google Gemini', textModel: 'gemini-2.5-pro', apiKeyConfigured: true },
    health: health ?? { connected: true, provider: 'gemini', providerName: 'Google Gemini', recommendedModel: 'gemini-3-flash', models: ['gemini-3-pro', 'gemini-2.5-pro'] },
    healthStatus: 200, testStatus: 200, testResult: { model: 'gemini-2.5-pro', reply: 'Nova este conectată.' }
  };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: element },
    window: { location: { replace: target => redirects.push(target) } },
    fetch: async (route, options) => {
      requests.push({ route, options });
      let status = 200, body;
      switch (route) {
        case '/api/billing/bank-orders': body = { orders: [] }; break;
        case '/api/settings': body = { settings: fixtures.settings }; break;
        case '/api/projects': body = { projects: [] }; break;
        case '/api/health': body = fixtures.health; status = fixtures.healthStatus; break;
        case '/api/ai/test': body = fixtures.testResult; status = fixtures.testStatus; break;
        default: throw new Error('Unexpected request: ' + route);
      }
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    }
  });
  vm.runInContext(script, context);
  const clickTest = () => nodes.get('testAi').listeners.click();
  const testedModels = () => requests.filter(request => request.route === '/api/ai/test').map(request => JSON.parse(request.options.body).model);
  return { context, nodes, fixtures, requests, redirects, clickTest, testedModels };
}

test('admin chat test uses the saved Gemini model before the recommended model or catalog order', async () => {
  const { context, nodes, clickTest, testedModels } = diagnosticContext();
  await context.refresh();
  assert.equal(nodes.get('model').textContent, 'gemini-2.5-pro');
  assert.equal(nodes.get('aiState').children[1].textContent, 'Google Gemini · catalog accesibil');
  assert.match(nodes.get('aiDiagnostic').textContent, /Chatul nu a fost încă testat/);
  assert.doesNotMatch(nodes.get('aiState').children[1].textContent, /conexiune verificată/);

  await clickTest();
  assert.deepEqual(testedModels(), ['gemini-2.5-pro']);
  assert.match(nodes.get('aiTestResult').textContent, /Test reușit · gemini-2\.5-pro/);
  assert.equal(nodes.get('testAi').disabled, false);
  assert.equal(nodes.get('testAi').textContent, 'Testează chatul AI');
});

test('admin chat test falls back to the recommended model and then catalog only when no model is saved', async () => {
  const { context, fixtures, clickTest, testedModels } = diagnosticContext();
  fixtures.settings.textModel = '';
  await context.refresh();
  await clickTest();
  fixtures.health.recommendedModel = '';
  await context.refresh();
  await clickTest();
  assert.deepEqual(testedModels(), ['gemini-3-flash', 'gemini-3-pro']);
});

test('admin can test the newly saved model even when catalog health is unavailable', async () => {
  const { context, fixtures, nodes, clickTest, testedModels } = diagnosticContext();
  await context.refresh();
  fixtures.settings.textModel = 'gemini-2.5-flash';
  fixtures.healthStatus = 503;
  fixtures.health = { error: 'Catalog temporar indisponibil' };
  await context.refresh();
  await clickTest();
  assert.deepEqual(testedModels(), ['gemini-2.5-flash']);
  assert.equal(nodes.get('aiState').className, 'pill off');
  assert.match(nodes.get('aiDiagnostic').textContent, /Nu a putut citi|nu a putut citi/);
});

test('failed admin chat diagnostics retain the server explanation and restore the test button', async () => {
  const { context, fixtures, nodes, redirects, clickTest, testedModels } = diagnosticContext();
  await context.refresh();
  fixtures.testStatus = 502;
  fixtures.testResult = { error: 'Google Gemini a respins cheia API. Verifică cheia și permisiunile furnizorului.' };
  await clickTest();
  assert.deepEqual(testedModels(), ['gemini-2.5-pro']);
  assert.equal(nodes.get('aiTestResult').textContent, fixtures.testResult.error);
  assert.equal(nodes.get('aiTestResult').className, 'muted error');
  assert.equal(nodes.get('testAi').disabled, false);
  assert.equal(nodes.get('testAi').textContent, 'Testează chatul AI');
  assert.deepEqual(redirects, []);
  assert.equal(nodes.get('aiState').children[1].textContent, 'Google Gemini · catalog accesibil');
});
