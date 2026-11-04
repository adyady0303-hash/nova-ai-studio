const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function element() {
  return {
    children: [], style: {}, hidden: false, textContent: '',
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  };
}

function usageContext(account, projectCount, profiles = [{ ready: { text: true } }]) {
  const nodes = Object.fromEntries([
    'accountLabel', 'subscriberUpgrade', 'subscriberPlanLabel', 'subscriberUpgradeTitle',
    'subscriberUpgradeDescription', 'subscriberUpgradeBtn', 'railUsage'
  ].map(id => [id, element()]));
  const context = vm.createContext({
    state: { account, projects: Array.from({ length: projectCount }, (_, id) => ({ id })) },
    el: id => nodes[id], providerProfiles: () => profiles,
    document: { createElement: element }
  });
  vm.runInContext(source.slice(source.indexOf('function textRoutingReady('), source.indexOf('function providerStatusText(')), context);
  vm.runInContext(source.slice(source.indexOf('function renderDashboardUsage('), source.indexOf('function renderProjects(')), context);
  vm.runInContext(source.slice(source.indexOf('function updateAccountLabel('), source.indexOf('async function loadAccount(')), context);
  return { context, nodes };
}

function usageRows(nodes) {
  return Object.fromEntries(nodes.railUsage.children.map(row => [row.children[0].textContent, {
    track: row.children[1], amount: row.children[2], fill: row.children[1].children[0]
  }]));
}

test('administrator sees unlimited creation and no quota bars beyond ten projects', () => {
  const { context, nodes } = usageContext({ role: 'owner', username: 'owner' }, 13);
  context.updateAccountLabel();

  assert.equal(nodes.accountLabel.textContent, 'owner · Administrator · Fără limită de creare');
  assert.equal(nodes.subscriberUpgrade.hidden, true);
  const rows = usageRows(nodes);
  assert.equal(rows['Cereri AI'].amount.textContent, 'Fără limită');
  assert.equal(rows.Proiecte.amount.textContent, '13 · Fără limită');
  for (const row of [rows['Cereri AI'], rows.Proiecte]) {
    assert.equal(row.track.hidden, true, 'administrator must not see an apparent filled creation quota');
    assert.equal(row.amount.style.gridColumn, '2 / -1');
  }
  assert.equal(rows.Motoare.amount.textContent, '1');
  assert.equal(rows.Motoare.track.hidden, false, 'configured engine indicator remains visible');
});

test('administrator creation remains unlimited when no AI engine is configured', () => {
  const { context, nodes } = usageContext({ role: 'owner', username: 'owner' }, 0, []);
  context.renderDashboardUsage();
  const rows = usageRows(nodes);
  assert.equal(rows['Cereri AI'].amount.textContent, 'Fără limită');
  assert.equal(rows.Proiecte.amount.textContent, '0 · Fără limită');
  assert.equal(rows.Motoare.amount.textContent, '0');
  assert.equal(rows.Motoare.fill.style.width, '0%');
});

test('subscriber still sees actual daily or monthly quota consumption and ten-project capacity', () => {
  const { context, nodes } = usageContext({ role: 'subscriber', username: 'ana', plan: 'free', quotaInterval: 'day', quotaLimit: 5, quotaRemaining: 3 }, 7);
  context.updateAccountLabel();
  let rows = usageRows(nodes);
  assert.match(nodes.accountLabel.textContent, /3\/5 unități AI azi/);
  assert.equal(nodes.subscriberUpgrade.hidden, false);
  assert.equal(rows['Cereri AI'].amount.textContent, '2/5');
  assert.equal(rows['Cereri AI'].fill.style.width, '40%');
  assert.equal(rows['Cereri AI'].track.hidden, false);
  assert.equal(rows.Proiecte.amount.textContent, '7');
  assert.equal(rows.Proiecte.fill.style.width, '70%');
  assert.equal(rows.Proiecte.track.hidden, false);

  context.state.account = { role: 'subscriber', username: 'ana', plan: 'standard', quotaInterval: 'month', quotaLimit: 300, quotaRemaining: 240 };
  context.updateAccountLabel();
  rows = usageRows(nodes);
  assert.match(nodes.accountLabel.textContent, /240\/300 unități AI lunar/);
  assert.equal(nodes.subscriberUpgrade.hidden, false);
  assert.equal(rows['Cereri AI'].amount.textContent, '60/300');
  assert.equal(rows['Cereri AI'].fill.style.width, '20%');
  assert.equal(rows['Cereri AI'].track.hidden, false);
});
