const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('visitor HTTP workflow: public plans, authenticated checkout, verified payment, quota and cancellation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-billing-'));
  const statePath = path.join(directory, 'stripe-state.json');
  const preloadPath = path.join(directory, 'stripe-mock.cjs');
  const state = { subscriptions: [] };
  const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state));
  saveState();
  fs.writeFileSync(preloadPath, `
    const fs = require('node:fs');
    global.fetch = async (url, options) => {
      const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
      const parsed = new URL(url);
      let result;
      if (parsed.hostname === 'api.openai.com' && parsed.pathname === '/v1/audio/speech') return {ok:true,headers:{get:()=> 'audio/mpeg'},arrayBuffer:async()=>Buffer.from('mock-audio-only')};
      if (parsed.hostname === 'api.openai.com') result = { choices: [{ message: { content: 'Salut din modelul de test.' } }], model: 'gpt-4.1-mini' };
      else if (parsed.hostname !== 'api.stripe.com') throw Error('Unexpected destination');
      else if (parsed.pathname === '/v1/prices/price_standard') result = { active:true, currency:'eur', unit_amount:999, recurring:{interval:'month',interval_count:1} };
      else if (parsed.pathname === '/v1/customers') result = { id:'cus_visitor' };
      else if (parsed.pathname === '/v1/checkout/sessions') result = { id:'cs_mock', url:'https://checkout.stripe.com/mock' };
      else if (parsed.pathname === '/v1/checkout/sessions/cs_mock') result = { status:'complete' };
      else if (parsed.pathname === '/v1/subscriptions') result = { data:state.subscriptions, has_more:false };
      else if (parsed.pathname === '/v1/subscriptions/sub_standard') result = state.subscription;
      else if (parsed.pathname === '/v1/billing_portal/sessions') result = { url:'https://billing.stripe.com/session/mock' };
      else throw Error('Unexpected Stripe route: '+parsed.pathname);
      return {ok:true, json:async()=>result};
    };
  `);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['--require', preloadPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NOVA_DATA_DIR: directory,
      NOVA_ACCESS_USER: 'owner', NOVA_ACCESS_PASSWORD: 'test-owner-password-long-enough',
      DATABASE_URL: '', NOVA_SUBSCRIBER_DAILY_AI_LIMIT: '5', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-key-only',
      STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
      STRIPE_STANDARD_PRICE_ID: 'price_standard', NOVA_PUBLIC_URL: 'https://nova.example',
      NOVA_BANK_IBAN: 'DE89370400440532013000', NOVA_BANK_BENEFICIARY: 'Beneficiar de test'
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert(ready, logs);
  assert.match(await (await fetch(base + '/plans.html')).text(), /9,99 €/);
  assert.equal((await fetch(base + '/api/billing')).status, 401);
  assert.equal((await fetch(base + '/api/media/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Salut' }) })).status, 401);
  assert.equal((await fetch(base + '/api/billing/checkout', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/billing/webhook', { method: 'POST', body: '{}' })).status, 400);
  const registration = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'visitor', password: 'pass1234' })
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const request = (route, body, origin = base) => fetch(base + route, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { cookie, origin, 'content-type': 'application/json' }
  });
  const me = await (await request('/api/auth/me')).json();
  assert.equal(me.plan, 'free'); assert.equal(me.quotaLimit, 5);
  assert.equal((await request('/api/billing/checkout', {}, 'https://attacker.example')).status, 403);
  const checkout = await request('/api/billing/checkout', {});
  assert.equal(checkout.status, 200); assert.equal((await checkout.json()).url, 'https://checkout.stripe.com/mock');
  assert.equal((await (await request('/api/billing')).json()).plan, 'free');
  state.subscription = {
    id: 'sub_standard', customer: 'cus_visitor', status: 'active', metadata: { nova_account_id: me.id },
    current_period_start: Math.floor(Date.now() / 1000) - 10, current_period_end: Math.floor(Date.now() / 1000) + 86400,
    latest_invoice: { id: 'in_paid', status: 'paid', paid: true, amount_paid: 999, currency: 'eur' },
    items: { data: [{ quantity: 1, price: { id: 'price_standard', currency: 'eur', unit_amount: 999, recurring: { interval: 'month', interval_count: 1 } } }] }
  };
  state.subscriptions = [state.subscription]; saveState();
  async function webhook(type = 'invoice.paid') {
    const raw = JSON.stringify({ type, data: { object: { subscription: 'sub_standard' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', 'whsec_mock_only').update(`${timestamp}.${raw}`).digest('hex');
    return fetch(base + '/api/billing/webhook', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } });
  }
  assert.equal((await webhook()).status, 200);
  assert.equal((await (await request('/api/auth/me')).json()).quotaLimit, 300);
  assert.equal((await request('/api/billing/checkout', {})).status, 409);
  const chat = await request('/api/chat', { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Salut' }] });
  assert.equal(chat.status, 200); assert.equal(chat.headers.get('x-nova-ai-remaining'), '299');
  assert.equal(chat.headers.get('x-nova-ai-interval'), 'month');
  assert.equal((await request('/api/media/image', { prompt: 'Un copac' })).status, 403);
  const publicVoice = await request('/api/media/speech', { text: 'a'.repeat(501) });
  assert.equal(publicVoice.status, 200);
  assert.match((await publicVoice.json()).dataUrl, /^data:audio\/mpeg;base64,/);
  assert.equal(publicVoice.headers.get('x-nova-ai-remaining'), '297');
  assert.equal((await request('/api/media/speech', { text: 'a'.repeat(4097) })).status, 400);
  assert.equal((await webhook()).status, 200);
  assert.equal((await (await request('/api/billing')).json()).remaining, 297);
  assert.equal((await request('/api/billing/portal', {})).status, 200);
  state.subscription.status = 'canceled'; saveState();
  assert.equal((await webhook()).status, 200);
  assert.equal((await (await request('/api/billing')).json()).plan, 'free');
  assert.equal((await request('/api/media/speech', { text: 'a'.repeat(2501) })).status, 429);
  assert.equal((await (await request('/api/billing')).json()).remaining, 5);
  const freeVoice = await request('/api/media/speech', { text: 'a'.repeat(501) });
  assert.equal(freeVoice.status, 200);
  assert.equal(freeVoice.headers.get('x-nova-ai-remaining'), '3');
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/chat', { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Salut' }] })).status, 200);
  assert.equal((await request('/api/chat', { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Salut' }] })).status, 429);
  const transfer = await request('/api/billing/bank-transfer', {});
  assert.equal(transfer.status, 200);
  const { order } = await transfer.json();
  assert.equal(order.amount, 999); assert.equal(order.currency, 'eur');
  assert.equal((await request('/api/billing/bank-confirm', { reference: order.reference })).status, 403);
  assert.equal((await request('/api/billing/bank-orders')).status, 403);
  assert.equal((await (await request('/api/billing')).json()).plan, 'free');
  const ownerLogin = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'owner', password: 'test-owner-password-long-enough' })
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/billing/bank-settings', { iban: 'DE89370400440532013000', beneficiary: 'Attacker' })).status, 403);
  const bankSettings = await fetch(base + '/api/billing/bank-settings', {
    method: 'POST', headers: { cookie: ownerCookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ iban: 'DE89370400440532013000', beneficiary: 'Beneficiar configurat din panou' })
  });
  assert.equal(bankSettings.status, 200);
  const pending = await fetch(base + '/api/billing/bank-orders', { headers: { cookie: ownerCookie } });
  assert.equal((await pending.json()).orders[0].reference, order.reference);
  const confirmation = await fetch(base + '/api/billing/bank-confirm', {
    method: 'POST', headers: { cookie: ownerCookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ reference: order.reference })
  });
  assert.equal(confirmation.status, 200);
  const manualSummary = await (await request('/api/billing')).json();
  assert.equal(manualSummary.plan, 'standard'); assert.equal(manualSummary.remaining, 300);
  assert.equal(manualSummary.paymentMethod, 'bank');
});
