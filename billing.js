"use strict";

const crypto = require("node:crypto");

const STANDARD_LIMIT = 300;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const idOf = value => typeof value === "string" ? value : value?.id;

function quotaFor(record, dailyLimit = 5, now = Date.now()) {
  const stripe = record.billing || {};
  const bank = record.bankAccess || {};
  const bankActive = bank.status === "active" && bank.periodStart * 1000 <= now && bank.periodEnd * 1000 > now;
  const stripeActive = stripe.status === "active" && stripe.periodStart * 1000 <= now && stripe.periodEnd * 1000 > now;
  const billing = stripeActive ? stripe : bankActive ? bank : {};
  const paid = billing.status === "active" && billing.periodStart * 1000 <= now && billing.periodEnd * 1000 > now;
  const period = paid ? String(billing.periodStart) : new Date(now).toISOString().slice(0, 10);
  const used = paid
    ? (record.paidUsagePeriod === period ? record.paidUsageCount || 0 : 0)
    : (record.usageDate === period ? record.usageCount || 0 : 0);
  const limit = paid ? STANDARD_LIMIT : dailyLimit;
  return { plan: paid ? "standard" : "free", period, limit, used, remaining: Math.max(0, limit - used), interval: paid ? "month" : "day", paymentMethod: paid ? stripeActive ? "stripe" : "bank" : null };
}

function bankConfiguration(env) {
  const iban = String(env.NOVA_BANK_IBAN || env.iban || "").replace(/\s/g, "").toUpperCase();
  const beneficiary = String(env.NOVA_BANK_BENEFICIARY || env.beneficiary || "").trim();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || !beneficiary || beneficiary.length > 160) return null;
  const rearranged = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of rearranged) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? { iban, beneficiary } : null;
}

function nextMonthTimestamp(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return Math.floor(date.getTime() / 1000);
}

function consumeQuota(record, dailyLimit, now, units = 1) {
  if (!Number.isSafeInteger(units) || units < 1) throw fail("Consum AI invalid.");
  const quota = quotaFor(record, dailyLimit, now);
  if (quota.remaining < units) return { ...quota, allowed: false };
  if (quota.plan === "standard") {
    record.paidUsagePeriod = quota.period;
    record.paidUsageCount = quota.used + units;
  } else {
    record.usageDate = quota.period;
    record.usageCount = quota.used + units;
  }
  return { ...quota, remaining: quota.remaining - units, allowed: true };
}

function verifyWebhook(raw, signature, secret, now = Date.now()) {
  if (!secret) throw fail("Plățile nu sunt încă configurate.", 503);
  const parts = String(signature || "").split(",").map(part => part.split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  if (!/^\d+$/.test(timestamp || "") || Math.abs(now / 1000 - Number(timestamp)) > 300) throw fail("Semnătură Stripe invalidă.");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  const valid = parts.some(([key, value]) => key === "v1" && /^[a-f0-9]{64}$/i.test(value || "") && crypto.timingSafeEqual(expected, Buffer.from(value, "hex")));
  if (!valid) throw fail("Semnătură Stripe invalidă.");
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw fail("Eveniment Stripe invalid."); }
}

function paidSubscription(subscription, priceId) {
  const items = subscription.items?.data || [];
  const invoice = subscription.latest_invoice;
  const item = items[0];
  const price = item?.price;
  return subscription.status === "active" && items.length === 1 && item.quantity === 1
    && price?.id === priceId && price.currency === "eur" && price.unit_amount === 999
    && price.recurring?.interval === "month" && price.recurring.interval_count === 1
    && invoice && typeof invoice !== "string" && invoice.paid === true
    && invoice.status === "paid" && invoice.currency === "eur" && invoice.amount_paid >= 999
    && subscription.current_period_end > subscription.current_period_start;
}

function createBilling({ readAccounts, writeAccounts, withAccountsLock, env = process.env, request = fetch }) {
  async function bankDetails(database) {
    const accounts = database || await readAccounts();
    return bankConfiguration(accounts.bankSettings || env);
  }
  function configuration() {
    const { STRIPE_WEBHOOK_SECRET: webhook, STRIPE_STANDARD_PRICE_ID: priceId, NOVA_PUBLIC_URL: publicUrl } = env;
    const key = paymentKey();
    let origin;
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw Error();
      origin = parsed.origin;
    } catch { return null; }
    return key && webhook && /^price_[A-Za-z0-9]+$/.test(priceId || "") ? { key, webhook, priceId, origin } : null;
  }

  function paymentKey() {
    return typeof env.STRIPE_SECRET_KEY === "string" ? env.STRIPE_SECRET_KEY.trim() : "";
  }

  async function stripe(route, fields, idempotencyKey, method, explicitKey, missingIsSuccess = false) {
    const config = configuration();
    const key = explicitKey || config?.key;
    if (!key) throw fail("Plățile nu sunt încă activate. Nu a fost efectuată nicio plată.", 503);
    const headers = { authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
    if (fields) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await request(`https://api.stripe.com/v1${route}`, {
      method: method || (fields ? "POST" : "GET"), headers,
      ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      if (missingIsSuccess && response.status === 404 && details?.error?.code === "resource_missing") return { missing: true };
      throw fail("Serviciul de plată nu a putut finaliza cererea. Reîncearcă sau contactează administratorul.", 503);
    }
    return response.json();
  }

  function ensureActive(record) {
    if (record.deleting) throw fail("Ștergerea contului este în curs.", 423);
    return record;
  }

  async function getRecord(account, { allowDeleting = false } = {}) {
    if (account.role !== "subscriber") throw fail("Abonamentele sunt pentru conturile vizitatorilor.", 403);
    const record = (await readAccounts()).users.find(user => user.id === account.userId);
    if (!record) throw fail("Contul nu mai există.", 401);
    return allowDeleting ? record : ensureActive(record);
  }

  async function summary(account, dailyLimit) {
    const record = await getRecord(account);
    const quota = quotaFor(record, dailyLimit);
    return {
      ...quota, paymentsEnabled: Boolean(configuration()), bankTransferEnabled: Boolean(await bankDetails()),
      hasCustomer: Boolean(record.billing?.customerId),
      cancelAtPeriodEnd: quota.paymentMethod === "bank" || Boolean(record.billing?.cancelAtPeriodEnd),
      periodEnd: (quota.paymentMethod === "bank" ? record.bankAccess?.periodEnd : record.billing?.periodEnd) || null,
      pendingBankTransfer: (record.bankOrders || []).find(order => order.status === "pending") || null
    };
  }

  async function checkout(account) {
    const config = configuration();
    if (!config) throw fail("Plățile nu sunt încă activate. Nu a fost efectuată nicio plată.", 503);
    const price = await stripe(`/prices/${config.priceId}`);
    if (!price.active || price.currency !== "eur" || price.unit_amount !== 999 || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1) {
      throw fail("Prețul Stripe trebuie să fie 9,99 EUR, recurent lunar.", 503);
    }
    return withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.id === account.userId);
      if (account.role !== "subscriber" || !record) throw fail("Cont de vizitator necesar.", 403);
      ensureActive(record);
      if (quotaFor(record).plan === "standard") throw fail("Planul Standard este deja activ.", 409);
      record.billing ||= {};
      // Reuse an open Checkout session; do not create simultaneous subscriptions.
      if (record.billing.checkoutId) {
        const session = await stripe(`/checkout/sessions/${encodeURIComponent(record.billing.checkoutId)}`);
        if (session.status === "open") return { url: session.url };
        record.billing.checkoutAttempt = null;
      }
      if (record.billing.customerId) {
        const subscriptions = await stripe(`/subscriptions?customer=${encodeURIComponent(record.billing.customerId)}&status=all&limit=100`);
        if (subscriptions.has_more || subscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) {
          throw fail("Există deja un abonament. Folosește «Gestionează abonamentul».", 409);
        }
      } else {
        const customer = await stripe("/customers", { "metadata[nova_account_id]": record.id }, `nova-customer-${record.id}`);
        record.billing.customerId = customer.id;
        await writeAccounts(database);
      }
      // Save a stable attempt ID before Stripe: retries after a timeout reuse it.
      record.billing.checkoutAttempt ||= crypto.randomUUID();
      await writeAccounts(database);
      const session = await stripe("/checkout/sessions", {
        mode: "subscription", customer: record.billing.customerId,
        "line_items[0][price]": config.priceId, "line_items[0][quantity]": "1",
        client_reference_id: record.id, "subscription_data[metadata][nova_account_id]": record.id,
        success_url: `${config.origin}/plans.html?checkout=success`, cancel_url: `${config.origin}/plans.html?checkout=cancelled`,
        "payment_method_types[0]": "card"
      }, `nova-checkout-${record.billing.checkoutAttempt}`);
      record.billing.checkoutId = session.id;
      await writeAccounts(database);
      return { url: session.url };
    });
  }

  async function portal(account) {
    const record = await getRecord(account);
    if (!record.billing?.customerId) throw fail("Nu există încă un abonament de administrat.");
    const config = configuration();
    if (!config) throw fail("Plățile nu sunt încă activate.", 503);
    const session = await stripe("/billing_portal/sessions", { customer: record.billing.customerId, return_url: `${config.origin}/plans.html` });
    return { url: session.url };
  }

  async function closeAccount(account) {
    if (account.role !== "subscriber") throw fail("Abonamentele sunt pentru conturile vizitatorilor.", 403);
    return withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.id === account.userId);
      if (!record) return { billingClosed: true };
      if (record.deletion?.billingClosedAt) return { billingClosed: true };
      const customerId = record.billing?.customerId;
      if (customerId) {
        if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) throw fail("Identificatorul contului de plată este invalid.", 503);
        const deleted = await stripe(`/customers/${encodeURIComponent(customerId)}`, undefined, undefined, "DELETE", paymentKey(), true);
        if (!deleted?.missing && (deleted?.deleted !== true || deleted.id !== customerId)) throw fail("Contul de plată nu a putut fi închis în siguranță.", 503);
      }
      record.deletion = { ...(record.deletion || {}), billingClosedAt: new Date().toISOString() };
      await writeAccounts(database);
      return { billingClosed: true };
    });
  }

  async function bankTransfer(account) {
    const bank = await bankDetails();
    if (!bank) throw fail("Transferul bancar nu este încă activat.", 503);
    await getRecord(account);
    return withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.id === account.userId);
      if (!record) throw fail("Contul nu mai există.", 401);
      ensureActive(record);
      if (quotaFor(record).plan === "standard") throw fail("Planul Standard este deja activ.", 409);
      if (record.billing?.customerId && configuration()) {
        const subscriptions = await stripe(`/subscriptions?customer=${encodeURIComponent(record.billing.customerId)}&status=all&limit=100`);
        if (subscriptions.has_more || subscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) throw fail("Există un abonament cu cardul. Gestionează-l înainte de a schimba metoda de plată.", 409);
      }
      record.bankOrders ||= [];
      let order = record.bankOrders.find(item => item.status === "pending");
      if (!order) {
        order = { reference: `NOVA-${crypto.randomBytes(8).toString("hex").toUpperCase()}`, status: "pending", amount: 999, currency: "eur", createdAt: new Date().toISOString(), ...bank };
        record.bankOrders.push(order);
        await writeAccounts(database);
      }
      return { order };
    });
  }

  async function bankOrders(account) {
    if (account.role !== "owner") throw fail("Doar administratorul poate verifica încasările.", 403);
    const database = await readAccounts();
    return {
      bankTransferEnabled: Boolean(await bankDetails(database)), bank: await bankDetails(database), cardPaymentsEnabled: Boolean(configuration()),
      orders: database.users.flatMap(user => (user.bankOrders || []).filter(order => order.status === "pending").map(order => ({ ...order, username: user.username })))
    };
  }

  async function saveBankSettings(account, body) {
    if (account.role !== "owner") throw fail("Doar administratorul poate configura încasările.", 403);
    const bank = bankConfiguration({ iban: body.iban, beneficiary: body.beneficiary });
    if (!bank) throw fail("Completează numele beneficiarului și un IBAN valid pentru contul de încasare în EUR.");
    await withAccountsLock(async () => {
      const database = await readAccounts(); database.bankSettings = bank; await writeAccounts(database);
    });
    return { saved: true, bank };
  }

  async function confirmBankTransfer(account, reference) {
    if (account.role !== "owner") throw fail("Doar administratorul poate confirma încasările.", 403);
    if (!/^NOVA-[A-F0-9]{16}$/.test(reference || "")) throw fail("Referință de transfer invalidă.");
    return withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.bankOrders?.some(order => order.reference === reference));
      if (!record) throw fail("Transferul nu există.", 404);
      ensureActive(record);
      const order = record.bankOrders.find(item => item.reference === reference);
      if (order.status === "confirmed") return { confirmed: true, alreadyConfirmed: true };
      if (quotaFor(record).plan === "standard") throw fail("Contul are deja un abonament activ. Verifică plata duplicată înainte de confirmare.", 409);
      if (record.billing?.customerId && configuration()) {
        const subscriptions = await stripe(`/subscriptions?customer=${encodeURIComponent(record.billing.customerId)}&status=all&limit=100`);
        if (subscriptions.has_more || subscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) throw fail("Contul are un abonament cu cardul. Verifică plata duplicată.", 409);
      }
      const time = Date.now();
      record.bankAccess = { status: "active", periodStart: Math.floor(time / 1000), periodEnd: nextMonthTimestamp(time), reference };
      order.status = "confirmed"; order.confirmedAt = new Date(time).toISOString();
      await writeAccounts(database);
      return { confirmed: true, periodEnd: record.bankAccess.periodEnd };
    });
  }

  async function webhook(raw, signature) {
    const event = verifyWebhook(raw, signature, env.STRIPE_WEBHOOK_SECRET);
    if (!["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) return { received: true };
    const object = event.data?.object;
    const subscriptionId = event.type.startsWith("invoice.") ? idOf(object?.subscription) : object?.id;
    if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId || "")) return { received: true };
    await withAccountsLock(async () => {
      // Fetch canonical state so replayed or reordered events cannot re-enable stale access.
      const subscription = await stripe(`/subscriptions/${subscriptionId}?expand[]=latest_invoice`);
      const database = await readAccounts();
      const record = database.users.find(user => user.billing?.customerId === idOf(subscription.customer));
      if (!record || subscription.metadata?.nova_account_id !== record.id) return;
      if (record.deleting) return;
      if (record.billing.subscriptionId && record.billing.subscriptionId !== subscription.id
          && quotaFor(record).plan === "standard") return;
      record.billing = {
        ...record.billing, subscriptionId: subscription.id,
        status: paidSubscription(subscription, configuration().priceId) ? "active" : subscription.status === "active" ? "unpaid" : subscription.status,
        periodStart: subscription.current_period_start, periodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
      };
      await writeAccounts(database);
    });
    return { received: true };
  }

  return { summary, checkout, portal, closeAccount, webhook, bankTransfer, bankOrders, confirmBankTransfer, saveBankSettings };
}

module.exports = { createBilling, quotaFor, consumeQuota, verifyWebhook, paidSubscription, bankConfiguration, nextMonthTimestamp };
