const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBilling, quotaFor, consumeQuota, verifyWebhook, paidSubscription, bankConfiguration, nextMonthTimestamp } = require('../billing');

const now = Date.parse('2026-10-19T12:00:00Z');
const env = {
  STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  STRIPE_STANDARD_PRICE_ID: 'price_standard', NOVA_PUBLIC_URL: 'https://nova.example'
};
const price = { id: 'price_standard', active: true, currency: 'eur', unit_amount: 999, recurring: { interval: 'month', interval_count: 1 } };
const account = { role: 'subscriber', userId: 'visitor1' };
function subscription(overrides = {}) {
  return {
    id: 'sub_standard', customer: 'cus_visitor', metadata: { nova_account_id: account.userId }, status: 'active',
    current_period_start: Math.floor(Date.now() / 1000) - 3600,
    current_period_end: Math.floor(Date.now() / 1000) + 86400,
    latest_invoice: { id: 'in_paid', paid: true, status: 'paid', currency: 'eur', amount_paid: 999 },
    items: { data: [{ quantity: 1, price }] }, ...overrides
  };
}
function signedEvent(type = 'invoice.paid', object = { subscription: 'sub_standard' }, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify({ id: 'evt_mock', type, data: { object } }));
  const signature = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.`).update(raw).digest('hex');
  return { raw, signature: `t=${timestamp},v1=${signature}` };
}
function harness(handler, record = { id: account.userId, billing: { customerId: 'cus_visitor' } }, config = env) {
  const database = { version: 1, users: [record] };
  const calls = [];
  let queue = Promise.resolve();
  const billing = createBilling({
    env: config, readAccounts: async () => structuredClone(database),
    writeAccounts: async value => Object.assign(database, structuredClone(value)),
    withAccountsLock: operation => {
      const result = queue.then(operation); queue = result.catch(() => {}); return result;
    },
    request: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.stripe.com');
      assert.equal(options.headers['Stripe-Version'], '2024-06-20');
      const call = { path: url.slice('https://api.stripe.com/v1'.length), fields: new URLSearchParams(options.body), options };
      calls.push(call);
      const result = await handler(call);
      return { ok: true, json: async () => result };
    }
  });
  return { billing, database, calls };
}

test('free requests are limited per UTC day and reset the next day', () => {
  const record = {};
  for (let i = 0; i < 5; i++) assert(consumeQuota(record, 5, now).allowed);
  assert.equal(consumeQuota(record, 5, now).allowed, false);
  assert.equal(consumeQuota(record, 5, now + 86400000).remaining, 4);
});

test('voice quota charges multiple units atomically and rejects invalid costs', () => {
  const record = {};
  assert.equal(consumeQuota(record, 5, now, 2).remaining, 3);
  assert.equal(consumeQuota(record, 5, now, 4).allowed, false);
  assert.equal(quotaFor(record, 5, now).remaining, 3);
  assert.equal(consumeQuota(record, 5, now, 3).remaining, 0);
  for (const invalid of [0, -1, 1.5, NaN]) assert.throws(() => consumeQuota(record, 5, now, invalid));
});

test('paid quota follows the billing period, survives midnight and resets only on a new period', () => {
  const record = { billing: { status: 'active', periodStart: now / 1000 - 100, periodEnd: now / 1000 + 86400 * 30 } };
  for (let i = 0; i < 300; i++) assert(consumeQuota(record, 5, now).allowed);
  assert.equal(consumeQuota(record, 5, now + 86400000).allowed, false);
  record.billing.periodStart += 86400 * 30; record.billing.periodEnd += 86400 * 30;
  assert.equal(consumeQuota(record, 5, now + 86400000 * 30).remaining, 299);
  assert.equal(quotaFor(record, 5, now + 86400000 * 61).plan, 'free');
});

test('past-due or future paid access falls back to the free plan', () => {
  assert.equal(quotaFor({ billing: { status: 'past_due', periodEnd: now / 1000 + 100 } }, 5, now).plan, 'free');
  assert.equal(quotaFor({ billing: { status: 'active', periodStart: now / 1000 + 10, periodEnd: now / 1000 + 100 } }, 5, now).plan, 'free');
});

test('Stripe webhook verification rejects missing, expired, future and tampered signatures', () => {
  const event = signedEvent();
  assert.equal(verifyWebhook(event.raw, event.signature, env.STRIPE_WEBHOOK_SECRET).type, 'invoice.paid');
  assert.throws(() => verifyWebhook(Buffer.from('{}'), event.signature, env.STRIPE_WEBHOOK_SECRET));
  assert.throws(() => verifyWebhook(event.raw, '', env.STRIPE_WEBHOOK_SECRET));
  for (const offset of [-600, 600]) {
    const stale = signedEvent('invoice.paid', {}, Math.floor(Date.now() / 1000) + offset);
    assert.throws(() => verifyWebhook(stale.raw, stale.signature, env.STRIPE_WEBHOOK_SECRET));
  }
});

test('paid entitlement requires a paid EUR invoice and the exact monthly plan and quantity', () => {
  assert(paidSubscription(subscription(), env.STRIPE_STANDARD_PRICE_ID));
  for (const overrides of [
    { status: 'past_due' }, { latest_invoice: 'in_not_expanded' },
    { latest_invoice: { paid: false, amount_paid: 999, status: 'open', currency: 'eur' } },
    { latest_invoice: { paid: true, amount_paid: 0, status: 'paid', currency: 'eur' } },
    { items: { data: [{ quantity: 2, price }] } },
    { items: { data: [{ quantity: 1, price: { ...price, currency: 'usd' } }] } },
    { items: { data: [{ quantity: 1, price: { ...price, id: 'price_other' } }] } }
  ]) assert.equal(Boolean(paidSubscription(subscription(overrides), env.STRIPE_STANDARD_PRICE_ID)), false);
});

test('missing Stripe configuration disables payments without preventing free use', async () => {
  const { billing, calls } = harness(() => { throw Error('Unexpected Stripe call'); }, undefined, {});
  const summary = await billing.summary(account, 5);
  assert.equal(summary.paymentsEnabled, false); assert.equal(summary.remaining, 5);
  await assert.rejects(billing.checkout(account), { status: 503 });
  assert.equal(calls.length, 0);
});

test('checkout validates the EUR price and ignores client-provided prices', async () => {
  const { billing, database, calls } = harness(call => {
    if (call.path.startsWith('/prices/')) return price;
    if (call.path === '/customers') return { id: 'cus_visitor' };
    if (call.path === '/checkout/sessions') return { id: 'cs_mock', url: 'https://checkout.stripe.com/mock' };
    throw Error(call.path);
  }, { id: account.userId });
  assert.equal((await billing.checkout(account)).url, 'https://checkout.stripe.com/mock');
  const checkout = calls.find(call => call.path === '/checkout/sessions');
  assert.equal(checkout.fields.get('line_items[0][price]'), env.STRIPE_STANDARD_PRICE_ID);
  assert.equal(checkout.fields.get('subscription_data[metadata][nova_account_id]'), account.userId);
  assert.equal(checkout.fields.get('success_url'), 'https://nova.example/plans.html?checkout=success');
  assert.equal(quotaFor(database.users[0]).plan, 'free'); // Redirects never grant access.
  assert.equal(database.users[0].billing.customerId, 'cus_visitor');
});

test('wrong Stripe price is rejected before creating a customer or charging', async () => {
  const { billing, calls } = harness(() => ({ ...price, unit_amount: 1999 }));
  await assert.rejects(billing.checkout(account), { status: 503 });
  assert.equal(calls.length, 1);
});

test('checkout reuses an open session and prevents duplicate active subscriptions', async () => {
  const open = harness(call => call.path.startsWith('/prices') ? price : { status: 'open', url: 'https://checkout.stripe.com/existing' }, { id: account.userId, billing: { customerId: 'cus_visitor', checkoutId: 'cs_open' } });
  assert.equal((await open.billing.checkout(account)).url, 'https://checkout.stripe.com/existing');
  assert.equal(open.calls.filter(call => call.options.method === 'POST').length, 0);
  const active = harness(call => call.path.startsWith('/prices') ? price : { data: [{ status: 'active' }], has_more: false });
  await assert.rejects(active.billing.checkout(account), { status: 409 });
});

test('checkout retries after a network timeout keep the same Stripe idempotency key', async () => {
  let attempt = 0; const keys = [];
  const { billing } = harness(call => {
    if (call.path.startsWith('/prices')) return price;
    if (call.path.startsWith('/subscriptions')) return { data: [], has_more: false };
    if (call.path === '/checkout/sessions') {
      keys.push(call.options.headers['Idempotency-Key']);
      if (attempt++ === 0) throw Error('Network timeout');
      return { id: 'cs_mock', url: 'https://checkout.stripe.com/mock' };
    }
    throw Error(call.path);
  });
  await assert.rejects(billing.checkout(account));
  await billing.checkout(account);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});

test('verified webhook activates paid access, replay does not reset use, canonical cancellation revokes access', async () => {
  let canonical = subscription();
  const { billing, database } = harness(() => canonical);
  const event = signedEvent();
  await billing.webhook(event.raw, event.signature);
  assert.equal(quotaFor(database.users[0]).plan, 'standard');
  consumeQuota(database.users[0], 5);
  await billing.webhook(event.raw, event.signature);
  assert.equal(quotaFor(database.users[0]).remaining, 299);
  canonical = subscription({ status: 'canceled' });
  await billing.webhook(event.raw, event.signature); // Old paid event now sees current cancellation.
  assert.equal(quotaFor(database.users[0]).plan, 'free');
});

test('webhook cannot link a payment to an unrelated Nova account', async () => {
  for (const overrides of [{ customer: 'cus_other' }, { metadata: { nova_account_id: 'other' } }]) {
    const { billing, database } = harness(() => subscription(overrides));
    const event = signedEvent(); await billing.webhook(event.raw, event.signature);
    assert.equal(quotaFor(database.users[0]).plan, 'free');
  }
});

test('portal is scoped to the authenticated customer and owners cannot buy a visitor plan', async () => {
  const { billing, calls } = harness(() => ({ url: 'https://billing.stripe.com/session/mock' }));
  await billing.portal(account);
  assert.equal(calls[0].fields.get('customer'), 'cus_visitor');
  await assert.rejects(billing.portal({ role: 'owner' }), { status: 403 });
});

const bankEnv = { NOVA_BANK_IBAN: 'DE89 3704 0044 0532 0130 00', NOVA_BANK_BENEFICIARY: 'Beneficiar de test' };
test('bank configuration checks IBAN checksum and requires a beneficiary', () => {
  assert.equal(bankConfiguration(bankEnv).iban, 'DE89370400440532013000');
  assert.equal(bankConfiguration({ ...bankEnv, NOVA_BANK_IBAN: 'DE00370400440532013000' }), null);
  assert.equal(bankConfiguration({ ...bankEnv, NOVA_BANK_BENEFICIARY: '' }), null);
});

test('a bank subscription lasts one calendar month, clamped at month end', () => {
  assert.equal(new Date(nextMonthTimestamp(Date.parse('2027-01-31T12:30:00Z')) * 1000).toISOString(), '2027-02-28T12:30:00.000Z');
  assert.equal(new Date(nextMonthTimestamp(Date.parse('2028-01-31T12:30:00Z')) * 1000).toISOString(), '2028-02-29T12:30:00.000Z');
});

test('bank transfer needs no Stripe; only an owner can confirm it, and confirming twice never extends access', async () => {
  const { billing, database, calls } = harness(() => { throw Error('No Stripe calls allowed'); }, { id: account.userId, username: 'visitor' }, bankEnv);
  const { order } = await billing.bankTransfer(account);
  assert.equal(order.amount, 999); assert.match(order.reference, /^NOVA-[A-F0-9]{16}$/);
  assert.equal((await billing.bankTransfer(account)).order.reference, order.reference);
  assert.equal(quotaFor(database.users[0]).plan, 'free');
  await assert.rejects(billing.confirmBankTransfer(account, order.reference), { status: 403 });
  await assert.rejects(billing.bankOrders(account), { status: 403 });
  const owner = { role: 'owner' };
  assert.equal((await billing.bankOrders(owner)).orders.length, 1);
  const first = await billing.confirmBankTransfer(owner, order.reference);
  assert.equal(first.confirmed, true); assert.equal(quotaFor(database.users[0]).plan, 'standard');
  assert.equal(quotaFor(database.users[0]).paymentMethod, 'bank');
  consumeQuota(database.users[0], 5);
  const second = await billing.confirmBankTransfer(owner, order.reference);
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(quotaFor(database.users[0]).remaining, 299);
  assert.equal(database.users[0].bankAccess.periodEnd, first.periodEnd);
  assert.equal((await billing.bankOrders(owner)).orders.length, 0);
  assert.equal((await billing.summary(account, 5)).cancelAtPeriodEnd, true);
  await assert.rejects(billing.bankTransfer(account), { status: 409 });
  assert.equal(calls.length, 0);
});

test('bank orders and confirmations block a parallel card subscription', async () => {
  const { billing } = harness(call => {
    assert(call.path.startsWith('/subscriptions?'));
    return { data: [{ status: 'active' }], has_more: false };
  }, { id: account.userId, billing: { customerId: 'cus_visitor' }, bankOrders: [{ reference: 'NOVA-1234567890ABCDEF', status: 'pending' }] }, { ...env, ...bankEnv });
  await assert.rejects(billing.bankTransfer(account), { status: 409 });
  await assert.rejects(billing.confirmBankTransfer({ role: 'owner' }, 'NOVA-1234567890ABCDEF'), { status: 409 });
});

test('an owner can configure bank receipts without Render or Stripe; settings persist and visitors cannot edit them', async () => {
  const { billing, database } = harness(() => { throw Error('No network'); }, { id: account.userId }, {});
  assert.equal((await billing.summary(account, 5)).bankTransferEnabled, false);
  await assert.rejects(billing.saveBankSettings(account, { iban: bankEnv.NOVA_BANK_IBAN, beneficiary: bankEnv.NOVA_BANK_BENEFICIARY }), { status: 403 });
  await assert.rejects(billing.saveBankSettings({ role: 'owner' }, { iban: 'invalid', beneficiary: 'Test' }), { status: 400 });
  assert.equal(database.bankSettings, undefined);
  await billing.saveBankSettings({ role: 'owner' }, { iban: bankEnv.NOVA_BANK_IBAN, beneficiary: bankEnv.NOVA_BANK_BENEFICIARY });
  assert.equal(database.bankSettings.iban, 'DE89370400440532013000');
  assert.equal((await billing.summary(account, 5)).bankTransferEnabled, true);
  const { order } = await billing.bankTransfer(account);
  assert.equal(order.beneficiary, bankEnv.NOVA_BANK_BENEFICIARY);
  // A changed destination cannot silently alter the instructions of an already requested transfer.
  await billing.saveBankSettings({ role: 'owner' }, { iban: bankEnv.NOVA_BANK_IBAN, beneficiary: 'Beneficiar nou' });
  assert.equal((await billing.bankTransfer(account)).order.beneficiary, bankEnv.NOVA_BANK_BENEFICIARY);
});
