const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const functionSource = source.slice(source.indexOf('function updateAccountLabel('), source.indexOf('async function loadAccount('));

test('upgrade card is subscriber-only and reflects free or paid state', () => {
  const nodes = Object.fromEntries([
    'accountLabel', 'subscriberUpgrade', 'subscriberPlanLabel', 'subscriberUpgradeTitle',
    'subscriberUpgradeDescription', 'subscriberUpgradeBtn'
  ].map(id => [id, { textContent: '', hidden: true }]));
  const context = vm.createContext({
    state: { account: null }, el: id => nodes[id], renderDashboardUsage() {}
  });
  vm.runInContext(functionSource, context);

  context.state.account = { role: 'subscriber', username: 'ana', plan: 'free', quotaInterval: 'day', quotaRemaining: 4, quotaLimit: 5 };
  context.updateAccountLabel();
  assert.equal(nodes.subscriberUpgrade.hidden, false);
  assert.equal(nodes.subscriberUpgradeTitle.textContent, 'Upgrade Pro / Premium');
  assert.equal(nodes.subscriberUpgradeBtn.textContent, 'Upgrade acum');

  context.state.account = { role: 'subscriber', username: 'ana', plan: 'standard', quotaInterval: 'month', quotaRemaining: 280, quotaLimit: 300 };
  context.updateAccountLabel();
  assert.equal(nodes.subscriberPlanLabel.textContent, 'PLAN PRO ACTIV');
  assert.equal(nodes.subscriberUpgradeBtn.textContent, 'Gestionează abonamentul');

  context.state.account = { role: 'owner', username: 'owner' };
  context.updateAccountLabel();
  assert.equal(nodes.subscriberUpgrade.hidden, true);
});
