const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function testWebConnection()'), source.indexOf('async function saveProviderSettings()'));

test('web check UI waits for a real result and restores the button on success or failure', async () => {
  const nodes = { testWebConnection: { disabled:false }, webConnectionStatus: { textContent:'' } };
  let resolve;
  const context = vm.createContext({ el: id => nodes[id], api: async route => { assert.equal(route,'/api/web/health'); return new Promise(done => { resolve = done; }); } });
  vm.runInContext(functionSource,context);
  const pending = context.testWebConnection();
  assert.equal(nodes.testWebConnection.disabled,true);
  assert.match(nodes.webConnectionStatus.textContent,/Se verifică/);
  resolve({ connected:true, sourceCount:3, version:'test-version' });
  await pending;
  assert.equal(nodes.testWebConnection.disabled,false);
  assert.match(nodes.webConnectionStatus.textContent,/Internet verificat.*3 surse.*test-version/);
  context.api = async () => ({ connected:false, error:'DNS indisponibil', version:'test-version' });
  await context.testWebConnection();
  assert.match(nodes.webConnectionStatus.textContent,/Acces web neconfirmat.*DNS indisponibil/);
  context.api = async () => { throw new Error('Server indisponibil'); };
  await context.testWebConnection();
  assert.equal(nodes.testWebConnection.disabled,false);
  assert.match(nodes.webConnectionStatus.textContent,/eșuat.*Server indisponibil/);
});
