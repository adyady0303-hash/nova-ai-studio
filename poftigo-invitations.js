"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const error = (status, message) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const emailOf = value => clean(value, 254).toLowerCase();
const validEmail = value => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const tokenValid = value => /^[a-f0-9]{64}$/.test(value || "");
const delayMs = 60_000;
const dayMs = 24 * 3600_000;
const maxPerDay = 15;

function inviteConfig(env = process.env) {
  let origin = "";
  try {
    const u = new URL(env.POFTIGO_PUBLIC_URL || "https://www.nova-ai-studio.eu");
    if (u.protocol === "https:" && !u.username && !u.password) origin = u.origin;
  } catch {}
  const from = clean(env.POFTIGO_INVITES_FROM, 180);
  const fromValid = !/[\r\n]/.test(from) && /@[^\s<>]+\.[A-Za-z]{2,}/.test(from);
  return {
    ready: Boolean(env.POFTIGO_INVITES_RESEND_API_KEY && fromValid && origin),
    enabled: env.POFTIGO_INVITES_ENABLED === "true" && Boolean(env.POFTIGO_INVITES_RESEND_API_KEY && fromValid && origin),
    from, origin
  };
}
function createPoftigoInvitations({ filesystem, root, withLock, fetchImpl = fetch, env = process.env, clock = () => Date.now() }) {
  const filename = path.join(root, "data", "poftigo-invitations.json");
  let delivering = false;
  async function read() {
    try {
      const value = JSON.parse(await filesystem().promises.readFile(filename, "utf8"));
      if (!Array.isArray(value.leads) || !Array.isArray(value.suppressed)) throw Error("Invalid invitation storage");
      return value;
    } catch (e) {
      if (e.code === "ENOENT") return { leads: [], suppressed: [] };
      throw e;
    }
  }
  async function write(value) {
    await filesystem().promises.mkdir(path.dirname(filename), { recursive: true });
    const temp = filename + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    try {
      await filesystem().promises.writeFile(temp, JSON.stringify(value), { mode: 0o600, encoding: "utf8" });
      await filesystem().promises.rename(temp, filename);
    } finally {
      await filesystem().promises.unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; });
    }
  }
  const present = row => {
    const { unsubscribeToken, ...safe } = row;
    return safe;
  };
  async function list() {
    const state = await read(), config = inviteConfig(env);
    return { ready: config.ready, enabled: config.enabled, dailyLimit: maxPerDay,
      leads: state.leads.slice(-300).reverse().map(present) };
  }
  async function add(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw error(400, "Date de invitație invalide.");
    const name = clean(input.name, 120), email = emailOf(input.email);
    const address = clean(input.address, 300), website = clean(input.website, 500);
    const osmId = clean(input.osmId, 70), consentEvidence = clean(input.consentEvidence, 500);
    if (name.length < 2 || !validEmail(email)) throw error(400, "Completează numele restaurantului și un email valid.");
    if (input.consentConfirmed !== true || consentEvidence.length < 12)
      throw error(400, "Pentru invitații automate este necesar acordul destinatarului și dovada acestuia.");
    if (website) {
      try { const u = new URL(website); if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw Error("invalid"); }
      catch { throw error(400, "Website invalid."); }
    }
    if (osmId && !/^osm-(node|way|relation)-[0-9]+$/.test(osmId)) throw error(400, "Identificator OSM invalid.");
    return withLock(async () => {
      const state = await read(), key = hash(email);
      if (state.suppressed.includes(key)) throw error(409, "Acest contact a refuzat invitațiile.");
      if (state.leads.some(row => row.email === email)) throw error(409, "Acest email există deja în lista de invitații.");
      if (state.leads.length >= 500) throw error(409, "Lista este plină. Arhivează contactele înainte să adaugi altele.");
      const lead = { id: crypto.randomBytes(12).toString("hex"), osmId, name, address, website, email,
        consentEvidence, consentConfirmedAt: new Date(clock()).toISOString(),
        unsubscribeToken: crypto.randomBytes(32).toString("hex"),
        status: "queued", createdAt: new Date(clock()).toISOString(),
        attemptedAt: null, sentAt: null, providerMessageId: null, error: null };
      state.leads.push(lead); await write(state);
      return { lead: present(lead) };
    });
  }
  async function cancel(id, suppress = false) {
    if (!/^[a-f0-9]{24}$/.test(id || "")) throw error(400, "Invitație invalidă.");
    return withLock(async () => {
      const state = await read(), row = state.leads.find(item => item.id === id);
      if (!row) throw error(404, "Invitație inexistentă.");
      if (suppress) {
        const emailHash = hash(row.email);
        if (!state.suppressed.includes(emailHash)) state.suppressed.push(emailHash);
        for (const lead of state.leads) if (lead.email === row.email && lead.status !== "sent") lead.status = "suppressed";
      } else if (row.status === "queued") row.status = "cancelled";
      else throw error(409, "O invitație deja trimisă sau în expediere nu mai poate fi anulată.");
      await write(state);
      return { ok: true };
    });
  }
  async function unsubscribe(token) {
    if (!tokenValid(token)) throw error(404, "Link invalid.");
    return withLock(async () => {
      const state = await read(), row = state.leads.find(item => item.unsubscribeToken === token);
      if (!row) throw error(404, "Link invalid.");
      const key = hash(row.email);
      if (!state.suppressed.includes(key)) state.suppressed.push(key);
      for (const item of state.leads) if (item.email === row.email && item.status !== "sent") item.status = "suppressed";
      await write(state);
      return { ok: true };
    });
  }
  async function validToken(token) {
    if (!tokenValid(token)) return false;
    const state = await read();
    return state.leads.some(item => item.unsubscribeToken === token);
  }
  function message(lead, config) {
    const unsubscribeUrl = config.origin + "/api/poftigo/invitations/unsubscribe?token=" + lead.unsubscribeToken;
    const text = [
      "Bună ziua, echipa " + lead.name + ",",
      "",
      "Vă invităm să analizați o posibilă colaborare cu Poftigo. Prin înscriere voluntară, restaurantul își poate publica meniul și poate primi cereri de comandă prin platformă.",
      "Comisionul propus este de 10% brut din comenzile plătite online prin Poftigo; taxele Stripe se aplică separat. Nu există o înscriere automată.",
      "",
      "Detalii și înscriere: " + config.origin + "/restaurants/manage",
      "Dacă doriți o ofertă personalizată, răspundeți la acest email.",
      "",
      "Poftigo · " + config.origin,
      "Nu mai doriți invitații? " + unsubscribeUrl
    ].join("\n");
    return { from: config.from, to: [lead.email], subject: "Invitație de colaborare Poftigo – " + lead.name,
      text, headers: { "List-Unsubscribe": "<" + unsubscribeUrl + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  }
  async function dispatchDue() {
    const config = inviteConfig(env);
    if (!config.enabled || delivering) return { sent: false, reason: "disabled-or-busy" };
    delivering = true;
    try {
      const lead = await withLock(async () => {
        const state = await read(), now = clock(), today = now - dayMs;
        // Fixed sending budget, including uncertain attempts, to limit accidental bursts.
        const attempts = state.leads.filter(r => r.attemptedAt && Date.parse(r.attemptedAt) > today);
        if (attempts.length >= maxPerDay || attempts.some(r => Date.parse(r.attemptedAt) > now - delayMs)) return null;
        const candidate = state.leads.find(r => r.status === "queued" && !state.suppressed.includes(hash(r.email)));
        if (!candidate) return null;
        candidate.status = "sending"; candidate.attemptedAt = new Date(now).toISOString();
        await write(state);
        return { ...candidate };
      });
      if (!lead) return { sent: false, reason: "no-eligible-leads" };
      let result, failed = null;
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST", signal: AbortSignal.timeout(12000),
          headers: { Authorization: "Bearer " + env.POFTIGO_INVITES_RESEND_API_KEY, "content-type": "application/json", "Idempotency-Key": "poftigo-invite-" + lead.id },
          body: JSON.stringify(message(lead, config))
        });
        if (!response.ok) throw error(response.status, "Furnizorul de email a respins trimiterea (HTTP " + response.status + ").");
        result = await response.json();
        if (!result.id) throw Error("No email id in provider response");
      } catch (e) {
        // Network timeouts can have succeeded upstream; never resend automatically.
        failed = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && e.status !== 429 ? "failed" : "uncertain";
      }
      await withLock(async () => {
        const state = await read(), row = state.leads.find(item => item.id === lead.id);
        if (!row) return;
        row.status = failed || "sent";
        row.error = failed ? failed === "failed" ? "Furnizorul a respins emailul. Verifică configurarea." : "Rezultat neconfirmat; verifică furnizorul înainte de retrimitere." : null;
        row.sentAt = failed ? null : new Date(clock()).toISOString();
        row.providerMessageId = result && typeof result.id === "string" ? result.id.slice(0, 120) : null;
        await write(state);
      });
      return { sent: !failed };
    } finally { delivering = false; }
  }
  return { list, add, cancel, unsubscribe, validToken, dispatchDue };
}
module.exports = { createPoftigoInvitations, inviteConfig };
