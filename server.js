const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dataStore = require("./data-store");
const { createBilling, quotaFor, consumeQuota } = require("./billing");
let dataFs = fs;

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DATA_DIR = process.env.NOVA_DATA_DIR || __dirname;
const ACCESS_USER = process.env.NOVA_ACCESS_USER || "";
const ACCESS_PASSWORD = process.env.NOVA_ACCESS_PASSWORD || "";
const configuredAiProvider = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
const aiProvider = {
  provider: configuredAiProvider === "ollama"
    ? "ollama"
    : configuredAiProvider === "openai" || Boolean(process.env.OPENAI_API_KEY) || process.env.NODE_ENV === "production"
      ? "openai"
      : "ollama",
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY || "",
  textModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini",
  speechModel: process.env.OPENAI_SPEECH_MODEL || "gpt-4o-mini-tts",
  voice: "nova"
};
const PUBLIC_DIR = path.join(__dirname, "public");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const BACKUPS_DIR = path.join(DATA_DIR, "data", "backups");
const PROJECT_TRASH_DIR = path.join(DATA_DIR, "data", "project-trash");
const ACCOUNTS_FILE = path.join(DATA_DIR, "data", "subscriber-accounts.json");
const MAX_ACCOUNTS = Math.max(1, Math.min(10000, Number.parseInt(process.env.NOVA_MAX_ACCOUNTS || "100", 10) || 100));
const SUBSCRIBER_DAILY_AI_LIMIT = Math.max(1, Math.min(5, Number.parseInt(process.env.NOVA_SUBSCRIBER_DAILY_AI_LIMIT || "5", 10) || 5));
const MAX_BODY = 1024 * 1024;
const MAX_FILE = 512 * 1024;

if (!new Set(["127.0.0.1", "localhost", "::1"]).has(HOST) && (!ACCESS_USER || ACCESS_PASSWORD.length < 20 || /^(replace-|change-me|changeme)/i.test(ACCESS_PASSWORD))) {
  throw new Error("Public binding needs NOVA_ACCESS_USER and a unique NOVA_ACCESS_PASSWORD of at least 20 characters; replace the example value first.");
}

const AUTH_COOKIE = "nova_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let accountQueue = Promise.resolve();
let aiSettingsCacheExpiresAt = 0;
const LOGIN_PAGE = `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Nova AI Studio</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#080b12;color:#eef2ff}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 15%,#1d2948 0,transparent 55%),#080b12}.card{width:min(100%,420px);padding:36px;border:1px solid #30394d;border-radius:24px;background:rgba(17,22,34,.96);box-shadow:0 24px 80px #0008}.mark{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;background:linear-gradient(135deg,#8b7cff,#4bd8c2);color:#080b12;font-weight:900;font-size:23px}h1{margin:22px 0 8px;font-size:26px;letter-spacing:-.04em}p{margin:0 0 24px;color:#a9b3c8;line-height:1.5}.benefit{margin:-10px 0 22px;padding:12px 14px;border:1px solid #25433f;border-radius:12px;background:#0b211f;color:#b6f2df;font-size:13px;line-height:1.5}label{display:block;margin:18px 0 8px;font-size:13px;color:#c7d0e2}input{width:100%;height:48px;padding:0 14px;border:1px solid #38445b;border-radius:12px;background:#0d121e;color:#fff;font:inherit;outline:none}input:focus{border-color:#8b7cff;box-shadow:0 0 0 3px #8b7cff33}.password-field{position:relative}.password-field input{padding-right:54px}.password-toggle{position:absolute;right:7px;top:7px;display:grid;place-items:center;width:36px;height:34px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:#a9b3c8;cursor:pointer}.password-toggle:hover{background:#ffffff0d;color:#eef2ff}.password-toggle:focus-visible{outline:2px solid #8b7cff;outline-offset:1px}.password-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.password-hint{display:block;margin-top:8px;color:#8490a7;font-size:12px}button{width:100%;height:48px;margin-top:22px;border:0;border-radius:12px;background:#8b7cff;color:#0b0c15;font:700 15px inherit;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.switch{display:block;width:auto;height:auto;margin:16px auto 0;padding:4px;background:transparent;color:#bdb4ff;font:inherit;text-decoration:underline}.status{min-height:22px;margin:14px 0 0;color:#ffaaa9;font-size:13px}.status.ok{color:#91ead1}footer{margin-top:24px;color:#8490a7;font-size:12px;text-align:center}[hidden]{display:none!important}
</style></head><body><main class="card"><div class="mark" aria-hidden="true">N</div><h1>Nova AI Studio</h1><p id="subtitle">Conectează-te pentru a deschide spațiul tău de lucru.</p><div id="benefit" class="benefit" hidden>Cont fără taxă de înscriere · __AI_LIMIT__ cereri AI pe zi. Conținutul trimis furnizorului configurat poate genera costuri.</div><form id="auth-form"><label for="username">Utilizator</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="32" required autofocus><label for="password">Parolă</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required><button class="password-toggle" type="button" data-password-toggle="password" aria-label="Afișează parola" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle><path data-password-slash d="M3 3l18 18" style="display:none"></path></svg></button></div><div id="confirm-wrap" hidden><label for="confirm-password">Confirmă parola</label><div class="password-field"><input id="confirm-password" type="password" autocomplete="new-password" maxlength="8"><button class="password-toggle" type="button" data-password-toggle="confirm-password" aria-label="Afișează parola" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle><path data-password-slash d="M3 3l18 18" style="display:none"></path></svg></button></div><small id="password-hint" class="password-hint" hidden>Parola abonatului poate avea cel mult 8 caractere.</small></div><button id="submit" type="submit">Autentificare</button><button id="switch" class="switch" type="button">Creează un cont de abonat</button><div id="status" class="status" role="status" aria-live="polite"></div></form><footer><a href="/plans.html" style="color:#bdb4ff">Vezi abonamentele · Standard 9,99 €/lună</a><br>Sesiune protejată · Nova AI Studio</footer></main><script>
const form=document.getElementById("auth-form"),button=document.getElementById("submit"),status=document.getElementById("status"),password=document.getElementById("password"),confirmPassword=document.getElementById("confirm-password"),confirmWrap=document.getElementById("confirm-wrap"),switchButton=document.getElementById("switch"),benefit=document.getElementById("benefit"),passwordHint=document.getElementById("password-hint"),passwordToggles=[...document.querySelectorAll("[data-password-toggle]")];let registering=false;
function resetPasswordVisibility(){for(const toggle of passwordToggles){const input=document.getElementById(toggle.dataset.passwordToggle);input.type="password";toggle.setAttribute("aria-pressed","false");toggle.setAttribute("aria-label","Afișează parola");const slash=toggle.querySelector("[data-password-slash]");if(slash)slash.style.display="none";}}
for(const toggle of passwordToggles){const input=document.getElementById(toggle.dataset.passwordToggle);toggle.addEventListener("click",()=>{const visible=input.type==="password";input.type=visible?"text":"password";toggle.setAttribute("aria-pressed",String(visible));toggle.setAttribute("aria-label",visible?"Ascunde parola":"Afișează parola");const slash=toggle.querySelector("[data-password-slash]");if(slash)slash.style.display=visible?"block":"none";});}
if(new URLSearchParams(location.search).get("session")==="expired"){status.textContent="Sesiunea a expirat. Autentifică-te din nou.";}
switchButton.addEventListener("click",()=>{registering=!registering;status.textContent="";status.classList.remove("ok");if(registering){password.value="";confirmPassword.value="";resetPasswordVisibility();}document.getElementById("subtitle").textContent=registering?"Creează un cont pentru spațiul tău privat Nova.":"Conectează-te pentru a deschide spațiul tău de lucru.";document.getElementById("submit").textContent=registering?"Creează cont":"Autentificare";switchButton.textContent=registering?"Am deja cont · Autentificare":"Creează un cont de abonat";confirmWrap.hidden=!registering;benefit.hidden=!registering;passwordHint.hidden=!registering;password.autocomplete=registering?"new-password":"current-password";confirmPassword.required=registering;if(registering){password.minLength=1;password.maxLength=8;confirmPassword.minLength=1;confirmPassword.maxLength=8;}else{password.removeAttribute("minlength");password.maxLength=128;confirmPassword.removeAttribute("minlength");confirmPassword.removeAttribute("required");}});form.addEventListener("submit",async event=>{event.preventDefault();if(registering&&password.value.length>8){status.textContent="Parola abonatului poate avea cel mult 8 caractere.";password.focus();return;}if(registering&&password.value!==confirmPassword.value){status.textContent="Parolele nu coincid.";confirmPassword.focus();return;}button.disabled=true;switchButton.disabled=true;status.textContent="";status.classList.remove("ok");try{const response=await fetch(registering?"/api/auth/register":"/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({username:document.getElementById("username").value,password:password.value})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"Cererea nu a putut fi finalizată.");password.value="";confirmPassword.value="";if(registering){status.textContent="Cont creat. Se deschide spațiul tău Nova…";status.classList.add("ok");}window.location.replace("/");}catch(error){status.textContent=error.message||"Nu s-a putut realiza autentificarea.";button.disabled=false;switchButton.disabled=false;password.focus();}});
</script></body></html>`;

function digestText(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function constantTimeTextEqual(value, expected) {
  return crypto.timingSafeEqual(digestText(value), digestText(expected));
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return "";
}

async function sessionFor(req) {
  const token = readCookie(req, AUTH_COOKIE);
  if (!token) return null;
  const session = dataStore.enabled ? await dataStore.getSession(token) : sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    if (dataStore.enabled) await dataStore.deleteSession(token);
    return null;
  }
  return session;
}

function normalizedUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

async function readAccounts() {
  try {
    const data = JSON.parse(await dataFs.promises.readFile(ACCOUNTS_FILE, "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.users)) throw new Error("Invalid account store");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, users: [] };
    throw Object.assign(new Error("Baza de conturi nu poate fi citită."), { status: 503 });
  }
}

async function writeAccounts(data) {
  const directory = path.dirname(ACCOUNTS_FILE);
  await dataFs.promises.mkdir(directory, { recursive: true });
  const temp = `${ACCOUNTS_FILE}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await dataFs.promises.writeFile(temp, JSON.stringify(data), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await dataFs.promises.rename(temp, ACCOUNTS_FILE); }
  catch (error) { await dataFs.promises.unlink(temp).catch(() => {}); throw error; }
}

async function withAccountsLock(operation) {
  const previous = accountQueue;
  let release;
  accountQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await dataStore.withLock(operation); }
  finally { release(); }
}

function cookieSecurityAttribute() {
  return new Set(["127.0.0.1", "localhost", "::1"]).has(HOST) ? "" : "; Secure";
}

async function createSession(res, account) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(token);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const session = { ...account, expiresAt: Date.now() + SESSION_TTL_MS };
  if (dataStore.enabled) {
    if (!await dataStore.createSession(token, account, session.expiresAt, 1000)) return false;
  } else {
    if (sessions.size >= 1000) return false;
    sessions.set(token, session);
  }
  res.setHeader("set-cookie", AUTH_COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200" + cookieSecurityAttribute());
  return true;
}

function sendLoginPage(res, headOnly = false) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  res.end(headOnly ? "" : LOGIN_PAGE.replace("__AI_LIMIT__", String(SUBSCRIBER_DAILY_AI_LIMIT)));
}

function sameOrigin(req) {
  let originHost = "";
  try { originHost = new URL(req.headers.origin || "").host; } catch {}
  return Boolean(originHost && originHost === req.headers.host);
}

async function login(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de autentificare respinsă." });
  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: "Cererea de autentificare nu este validă." }); }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length > 300 || password.length > 128) return json(res, 401, { error: "Utilizatorul sau parola nu sunt corecte." });

  let account = null;
  if (constantTimeTextEqual(username, ACCESS_USER) && constantTimeTextEqual(password, ACCESS_PASSWORD)) {
    account = { userId: "owner", role: "owner", username: ACCESS_USER };
  } else {
    const record = (await readAccounts()).users.find(item => item.usernameKey === normalizedUsername(username));
    if (record && typeof record.salt === "string" && typeof record.passwordHash === "string") {
      const candidate = Buffer.from(passwordHash(password, record.salt), "base64");
      const expected = Buffer.from(record.passwordHash, "base64");
      if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
        account = { userId: record.id, role: "subscriber", username: record.username };
      }
    }
  }
  if (!account) return json(res, 401, { error: "Utilizatorul sau parola nu sunt corecte." });
  if (!await createSession(res, account)) return json(res, 503, { error: "Sunt prea multe sesiuni active. Încearcă mai târziu." });
  return json(res, 200, { ok: true });
}

async function register(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de înregistrare respinsă." });
  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: "Completează numele de utilizator și parola." }); }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const usernameKey = normalizedUsername(username);
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return json(res, 400, { error: "Numele trebuie să aibă 3–32 caractere: litere, cifre, punct, _ sau - ." });
  }
  if (password.length < 1 || password.length > 8) {
    return json(res, 400, { error: "Parola abonatului trebuie să aibă între 1 și 8 caractere." });
  }
  if (password.toLowerCase() === username.toLowerCase()) return json(res, 400, { error: "Parola trebuie să fie diferită de numele de utilizator." });
  if (usernameKey === normalizedUsername(ACCESS_USER)) return json(res, 409, { error: "Acest nume este rezervat administratorului." });

  let account;
  try {
    account = await withAccountsLock(async () => {
      const database = await readAccounts();
      if (database.users.some(user => user.usernameKey === usernameKey)) throw Object.assign(new Error("Acest nume de utilizator este deja folosit."), { status: 409 });
      if (database.users.length >= MAX_ACCOUNTS) throw Object.assign(new Error("Înregistrările sunt momentan închise. Numărul maxim de conturi a fost atins."), { status: 503 });
      const salt = crypto.randomBytes(16).toString("base64url");
      const record = { id: crypto.randomBytes(16).toString("hex"), username, usernameKey, salt, passwordHash: passwordHash(password, salt), usageDate: "", usageCount: 0, createdAt: new Date().toISOString() };
      database.users.push(record);
      await writeAccounts(database);
      return { userId: record.id, role: "subscriber", username: record.username };
    });
  } catch (error) {
    return json(res, error.status || 503, { error: error.message || "Contul nu a putut fi creat." });
  }
  if (!await createSession(res, account)) return json(res, 503, { error: "Contul a fost creat, dar sunt prea multe sesiuni active. Autentifică-te." });
  return json(res, 201, { ok: true });
}

async function consumeAiQuota(req, res) {
  const account = req.novaAccount || { userId: "owner", role: "owner", username: ACCESS_USER || "local" };
  if (account.role === "owner") return true;
  try {
    if (["/api/media/image", "/api/media/speech"].includes(new URL(req.url, "http://nova").pathname)) {
      json(res, 403, { error: "Imaginile și vocea AI nu sunt incluse în planurile Gratuit și Standard. Nu au fost consumate mesaje." });
      return false;
    }
    const quota = await withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.id === account.userId);
      if (!record) throw Object.assign(new Error("Contul nu mai este disponibil. Autentifică-te din nou."), { status: 401 });
      const quota = consumeQuota(record, SUBSCRIBER_DAILY_AI_LIMIT);
      if (quota.allowed) await writeAccounts(database);
      return quota;
    });
    res.setHeader("x-nova-ai-remaining", String(quota.remaining));
    res.setHeader("x-nova-ai-limit", String(quota.limit));
    res.setHeader("x-nova-ai-interval", quota.interval);
    if (!quota.allowed) {
      json(res, 429, { error: quota.plan === "standard"
        ? "Ai folosit cele 300 de mesaje AI ale perioadei lunare. Limita se reînnoiește la următoarea perioadă plătită."
        : `Ai folosit limita de ${quota.limit} mesaje AI pentru astăzi. Revino mâine sau alege abonamentul Standard.` });
      return false;
    }
    return true;
  } catch (error) {
    json(res, error.status || 503, { error: error.message || "Nu am putut verifica limita contului." });
    return false;
  }
}

if (!new Set(["127.0.0.1", "localhost", "::1"]).has(HOST) && (!ACCESS_USER || ACCESS_PASSWORD.length < 20 || /^(replace-|change-me|changeme)/i.test(ACCESS_PASSWORD))) {
  throw new Error("Public binding needs NOVA_ACCESS_USER and a unique NOVA_ACCESS_PASSWORD of at least 20 characters; replace the example value first.");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        settled = true;
        reject(Object.assign(new Error("Cererea este prea mare."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", error => { if (!settled) reject(error); });
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Corpul cererii nu este JSON valid."), { status: 400 }); }
}

const billing = createBilling({ readAccounts, writeAccounts, withAccountsLock });

async function ollamaJson(route, options = {}) {
  const response = await fetch(`${OLLAMA}${route}`, {
    ...options,
    signal: AbortSignal.timeout(120000),
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Ollama a răspuns cu HTTP ${response.status}.`);
  }
  return data;
}

function publicProviderSettings() {
  return {
    provider: aiProvider.provider,
    baseUrl: aiProvider.baseUrl,
    textModel: aiProvider.textModel,
    imageModel: aiProvider.imageModel,
    speechModel: aiProvider.speechModel,
    voice: aiProvider.voice,
    apiKeyConfigured: Boolean(aiProvider.apiKey)
  };
}

function aiSettingsCipherKey() {
  const secret = process.env.NOVA_DATA_ENCRYPTION_KEY || ACCESS_PASSWORD || process.env.DATABASE_URL || "";
  if (!secret) throw new Error("Lipsește cheia pentru criptarea configurării AI persistente.");
  return crypto.createHash("sha256").update(secret).digest();
}

function storedAiSettings() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aiSettingsCipherKey(), iv);
  const encryptedKey = Buffer.concat([cipher.update(aiProvider.apiKey || "", "utf8"), cipher.final()]);
  return {
    provider: aiProvider.provider,
    baseUrl: aiProvider.baseUrl,
    textModel: aiProvider.textModel,
    imageModel: aiProvider.imageModel,
    speechModel: aiProvider.speechModel,
    voice: aiProvider.voice,
    apiKeyCipher: encryptedKey.toString("base64"),
    apiKeyIv: iv.toString("base64"),
    apiKeyTag: cipher.getAuthTag().toString("base64")
  };
}

function applyStoredAiSettings(value) {
  if (!value || !["openai", "ollama"].includes(value.provider)) return;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", aiSettingsCipherKey(), Buffer.from(value.apiKeyIv, "base64"));
    decipher.setAuthTag(Buffer.from(value.apiKeyTag, "base64"));
    const apiKey = Buffer.concat([
      decipher.update(Buffer.from(value.apiKeyCipher || "", "base64")),
      decipher.final()
    ]).toString("utf8");
    Object.assign(aiProvider, {
      provider: value.provider,
      baseUrl: String(value.baseUrl || aiProvider.baseUrl),
      textModel: String(value.textModel || aiProvider.textModel),
      imageModel: String(value.imageModel || aiProvider.imageModel),
      speechModel: String(value.speechModel || aiProvider.speechModel),
      voice: String(value.voice || aiProvider.voice),
      apiKey: apiKey || aiProvider.apiKey
    });
  } catch (error) {
    console.error("Nova AI settings could not be decrypted; using environment configuration.");
  }
}

async function refreshAiSettings(force = false) {
  if (!dataStore.enabled || (!force && Date.now() < aiSettingsCacheExpiresAt)) return;
  const value = await dataStore.getSetting("ai-provider");
  if (value) applyStoredAiSettings(value);
  aiSettingsCacheExpiresAt = Date.now() + 1000;
}

async function persistAiSettings() {
  if (dataStore.enabled) await dataStore.setSetting("ai-provider", storedAiSettings());
  aiSettingsCacheExpiresAt = 0;
}

function configuredAiUrl(route) {
  return `${aiProvider.baseUrl.replace(/\/+$/, "")}${route}`;
}

async function openAiJson(route, options = {}, timeout = 180000) {
  if (!aiProvider.apiKey) throw new Error("Adaugă cheia API în Configurare AI înainte să folosești acest furnizor.");
  const response = await fetch(configuredAiUrl(route), {
    ...options,
    signal: AbortSignal.timeout(timeout),
    headers: {
      authorization: `Bearer ${aiProvider.apiKey}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.error || `Furnizorul AI a răspuns cu HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function openAiBytes(route, body, timeout = 180000) {
  if (!aiProvider.apiKey) throw new Error("Adaugă cheia API în Configurare AI înainte să folosești acest furnizor.");
  const response = await fetch(configuredAiUrl(route), {
    method: "POST",
    headers: { authorization: `Bearer ${aiProvider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error?.message || data.error || `Furnizorul AI a răspuns cu HTTP ${response.status}.`), { status: response.status });
  }
  const mime = (response.headers.get("content-type") || "audio/mpeg").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("audio/") && mime !== "application/octet-stream") throw new Error("Furnizorul vocal nu a returnat un fișier audio.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Furnizorul vocal a returnat un fișier gol.");
  return { mime: mime === "application/octet-stream" ? "audio/mpeg" : mime, base64: bytes.toString("base64") };
}

async function providerChat(model, messages, tools, maxOutputTokens = null) {
  if (aiProvider.provider === "ollama") {
    const result = await ollamaJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({ model, stream: false, messages, tools, options: { temperature: 0.2, ...(maxOutputTokens ? { num_predict: maxOutputTokens } : {}) } })
    });
    return { message: result.message || {}, model: result.model || model };
  }
  const result = await openAiJson("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages, tools, ...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}) })
  });
  return { message: result.choices?.[0]?.message || {}, model: result.model || model };
}

function validProjectId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function workspacePaths(principal = "owner") {
  if (principal === "owner") return { projects: PROJECTS_DIR, backups: BACKUPS_DIR, trash: PROJECT_TRASH_DIR };
  if (!/^[a-f0-9]{32}$/.test(principal)) throw Object.assign(new Error("Spațiul utilizatorului este invalid."), { status: 403 });
  const userRoot = path.resolve(DATA_DIR, "users", principal);
  return { projects: path.join(userRoot, "projects"), backups: path.join(userRoot, "backups"), trash: path.join(userRoot, "project-trash") };
}

function projectRoot(project, principal = "owner") {
  if (!validProjectId(project)) throw Object.assign(new Error("Proiect invalid."), { status: 400 });
  const base = workspacePaths(principal).projects;
  const root = path.resolve(base, project);
  if (!root.startsWith(`${base}${path.sep}`)) throw Object.assign(new Error("Cale de proiect invalidă."), { status: 400 });
  return root;
}

async function assertProjectParent(target) {
  let rootStat;
  try { rootStat = await dataFs.promises.lstat(target.root); }
  catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error("Proiectul nu există."), { status: 404 }); throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("Proiectul nu este un dosar local obișnuit."), { status: 403 });
  if (dataStore.enabled) {
    let parent = path.dirname(target.full);
    while (parent !== target.root && parent.startsWith(`${target.root}${path.sep}`)) {
      let stat;
      try { stat = await dataFs.promises.lstat(parent); }
      catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error("Dosarul părinte nu există."), { status: 404 }); throw error; }
      if (!stat.isDirectory()) throw Object.assign(new Error("Dosarul părinte nu este valid."), { status: 403 });
      parent = path.dirname(parent);
    }
  } else {
    const rootReal = await dataFs.promises.realpath(target.root);
    const parentReal = await dataFs.promises.realpath(path.dirname(target.full));
    if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) throw Object.assign(new Error("Calea nu poate ieși din proiectul deschis."), { status: 403 });
  }
}

function projectFile(project, name, principal = "owner") {
  if (typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Numele fișierului lipsește."), { status: 400 });
  const portable = name.replace(/\\/g, "/");
  if (portable.startsWith("/") || portable.split("/").some(part => !part || part === "." || part === ".." || [".nova-backups", ".nova-project.json", ".git", "node_modules"].includes(part))) {
    throw Object.assign(new Error("Calea fișierului nu este permisă."), { status: 400 });
  }
  const root = projectRoot(project, principal);
  const full = path.resolve(root, ...portable.split("/"));
  if (!full.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("Calea fișierului nu este permisă."), { status: 400 });
  return { root, full, relative: portable };
}

async function pathExists(filePath) {
  try { await dataFs.promises.lstat(filePath); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function listProjectFiles(root) {
  let rootStat;
  try { rootStat = await dataFs.promises.lstat(root); }
  catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error("Proiectul nu există."), { status: 404 }); throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("Proiectul nu este un dosar local obișnuit."), { status: 404 });
  const out = [];
  async function visit(folder, relative = "") {
    for (const entry of await dataFs.promises.readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".nova-backups" || entry.name === ".nova-project.json") continue;
      const abs = path.join(folder, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) {
        const stat = await dataFs.promises.stat(abs);
        out.push({ path: rel, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function readProjectFile(project, name, principal = "owner") {
  const target = projectFile(project, name, principal);
  await assertProjectParent(target);
  const stat = await dataFs.promises.lstat(target.full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("Fișierul nu există sau nu este un fișier obișnuit."), { status: 404 });
  if (stat.size > MAX_FILE) throw Object.assign(new Error("Fișierul depășește limita de 512 KiB."), { status: 413 });
  return await dataFs.promises.readFile(target.full, "utf8");
}

async function writeProjectFile(project, name, content, principal = "owner") {
  if (typeof content !== "string") throw Object.assign(new Error("Conținutul fișierului trebuie să fie text."), { status: 400 });
  if (Buffer.byteLength(content, "utf8") > MAX_FILE) throw Object.assign(new Error("Fișierul depășește limita de 512 KiB."), { status: 413 });
  const target = projectFile(project, name, principal);
  await dataFs.promises.mkdir(path.dirname(target.full), { recursive: true });
  await assertProjectParent(target);
  let existed = false;
  try {
    const stat = await dataFs.promises.lstat(target.full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("Ținta nu este un fișier obișnuit."), { status: 400 });
    existed = true;
    const backupFile = path.join(workspacePaths(principal).backups, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bak`;
    await dataFs.promises.mkdir(path.dirname(backupFile), { recursive: true });
    await dataFs.promises.copyFile(target.full, backupFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!existed) {
    const marker = path.join(workspacePaths(principal).backups, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.created`;
    await dataFs.promises.mkdir(path.dirname(marker), { recursive: true });
    await dataFs.promises.writeFile(marker, "", "utf8");
  }
  await dataFs.promises.writeFile(target.full, content, "utf8");
  return { path: target.relative, action: existed ? "updated" : "created" };
}

const agentTools = [
  { type: "function", function: { name: "list_files", description: "List the files in the open project.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file from the open project.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Project-relative path, such as src/index.js" } }, additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or update a UTF-8 text file in the open project. Only call this when the user asked to implement changes.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string", description: "Project-relative file path" }, content: { type: "string", description: "Complete UTF-8 file content" } }, additionalProperties: false } } }
];

async function callAgentTool(name, args, project, allowChanges, principal = "owner") {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Argumente de unealtă invalide.");
  if (name === "list_files") return JSON.stringify(await listProjectFiles(projectRoot(project, principal)));
  if (name === "read_file") return await readProjectFile(project, args.path, principal);
  if (name === "write_file") {
    if (!allowChanges) throw new Error("Scrierea este dezactivată. Activează «Permite modificări» pentru agent.");
    const result = await writeProjectFile(project, args.path, args.content, principal);
    return `Fișier ${result.action}: ${result.path}. O copie anterioară a fost salvată pentru anulare.`;
  }
  throw new Error(`Unealtă necunoscută: ${name}`);
}

async function runAgent(model, inputMessages, project, mode, allowChanges, task = "auto", principal = "owner") {
  const taskPrompts = {
    auto: "Detectează intenția utilizatorului. Pentru cod, construiește sau explică proiecte pentru Windows și PC. Pentru versuri, scrie versuri originale complete. Pentru o cerere de muzică, livrează planul și încheie cu un bloc de cod Markdown etichetat nova-music, care conține JSON valid {\"title\":\"Titlu\",\"bpm\":96,\"notes\":[{\"note\":\"A3\",\"beats\":1}]}; pentru video, livrează scenariul și încheie cu un bloc nova-video care conține JSON valid {\"title\":\"Titlu\",\"scenes\":[{\"text\":\"Cadru\",\"seconds\":4,\"background\":\"#18221a\"}]}. Respectă limitele din instrucțiunile modului media. Aplicația sintetizează WAV simplu și exportă scene tipografice WebM.",
    code: "Construiește aplicații și unelte pentru PC, cu prioritate pentru Windows 10/11. Oferă fișiere complete, instrucțiuni de instalare și dependențe; explorează proiectul înainte să scrii.",
    lyrics: "Scrie versuri originale în limba utilizatorului, cu titlu și secțiuni clare (strofe, refren, punte). Respectă tema, genul, tonul și lungimea cerute. Nu imita versurile sau stilul exact al unui artist în viață; descrie trăsături muzicale generale. Dacă utilizatorul cere, salvează versurile într-un fișier text.",
    music: "Creează o compoziție originală. Scrie mai întâi titlul, genul, versurile dacă sunt cerute, tempo-ul, tonalitatea, acordurile și structura. Încheie cu un bloc de cod Markdown etichetat nova-music; în interior pune doar JSON valid: {\"title\":\"Titlu\",\"bpm\":96,\"notes\":[{\"note\":\"A3\",\"beats\":1},{\"note\":\"C4\",\"beats\":1}]}. Notele trebuie să aibă nume A-G cu diez opțional și octavă 2-6; beats între 0.25 și 4. Limitează compoziția la 128 note. Nova sintetizează notele într-un WAV simplu fără voce cântată; nu pretinde că produce o înregistrare vocală sau instrumente realiste.",
    video: "Creează un concept video original, scenariu, voice-over/subtitrări și cadre. Încheie cu un bloc de cod Markdown etichetat nova-video; în interior pune doar JSON valid: {\"title\":\"Titlu\",\"scenes\":[{\"text\":\"Textul cadrului\",\"seconds\":4,\"background\":\"#18221a\"}]}. Include 2-12 scene; fiecare are text, seconds între 2 și 8 și background hex de forma #RRGGBB. Nova exportă scenele ca videoclip tipografic WebM cu fundaluri colorate; nu pretinde că generează imagini, filmări sau voci."
  };
  const prompt = mode === "review"
    ? "Ești Nova, agent de revizie de cod. Inspectează proiectul cu uneltele list_files și read_file. Nu modifica fișierele. Identifică probleme reale, ordonează-le după severitate și indică fișierele relevante."
    : mode === "plan"
      ? "Ești Nova, agent de planificare software. Explorează proiectul cu list_files și read_file, apoi prezintă un plan ordonat și clar. Nu modifica fișierele."
      : `Ești Nova, asistent de creație și programare. ${taskPrompts[task] || taskPrompts.auto} Explorează proiectul și fișierele relevante când cererea depinde de ele. Implementează cererile de cod folosind write_file numai când este permis. Păstrează schimbările la obiect și raportează fiecare fișier schimbat. Nu rula comenzi și nu pretinde că ai testat codul.`;
  const messages = [
    { role: "system", content: `${prompt}\n\nAi acces numai la fișierele proiectului deschis, prin uneltele list_files, read_file și write_file. Nu ai terminal, acces la internet sau acces la alte dosare. ${allowChanges ? "Modificările sunt permise pentru această cerere." : "Modificările sunt dezactivate pentru această cerere."} Păstrează căile relative în proiect și nu șterge fișiere.` },
    ...inputMessages.slice(-12)
  ];
  const tools = allowChanges ? agentTools : agentTools.filter(tool => tool.function.name !== "write_file");
  const events = [];
  const maxRounds = principal === "owner" ? 8 : 4;
  for (let round = 0; round < maxRounds; round++) {
    const response = await providerChat(model, messages, tools, principal === "owner" ? null : 1500);
    const message = response.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push(message);
    if (!calls.length) return { content: message.content || "Agentul a terminat fără un răspuns text.", events, model: response.model || model };
    for (const call of calls) {
      const name = call.function?.name;
      try {
      let args = call.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      const result = await callAgentTool(name, args, project, allowChanges, principal);
        events.push({ tool: name, ok: true, summary: name === "write_file" ? result : name === "list_files" ? "Lista de fișiere citită" : `Fișier citit: ${args.path}` });
        const toolResultLimit = principal === "owner" ? 30000 : 10000;
        messages.push(aiProvider.provider === "openai"
          ? { role: "tool", tool_call_id: call.id, content: String(result).slice(0, toolResultLimit) }
          : { role: "tool", tool_name: name, content: String(result).slice(0, toolResultLimit) });
      } catch (error) {
        events.push({ tool: name || "unknown", ok: false, summary: error.message });
        messages.push(aiProvider.provider === "openai"
          ? { role: "tool", tool_call_id: call.id, content: `Eroare: ${error.message}` }
          : { role: "tool", tool_name: name || "unknown", content: `Eroare: ${error.message}` });
      }
    }
  }
  return { content: "Am atins limita de pași a agentului. Verifică schimbările efectuate și trimite o cerere de continuare dacă mai este nevoie.", events, model };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    try { await dataStore.healthCheck(); return json(res, 200, { ok: true }); }
    catch { return json(res, 503, { ok: false, error: "Storage unavailable" }); }
  }

  if (req.method === "POST" && url.pathname === "/api/billing/webhook") {
    const result = await billing.webhook(await readBody(req), req.headers["stripe-signature"]);
    return json(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/plans.html") {
    const page = await fs.promises.readFile(path.join(PUBLIC_DIR, "plans.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return res.end(page);
  }
  if (ACCESS_PASSWORD && req.method === "POST" && url.pathname === "/api/auth/login") return login(req, res);
  if (ACCESS_PASSWORD && req.method === "POST" && url.pathname === "/api/auth/register") return register(req, res);
  if (ACCESS_PASSWORD && req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = readCookie(req, AUTH_COOKIE);
    if (token) sessions.delete(token);
    if (token && dataStore.enabled) await dataStore.deleteSession(token);
    res.setHeader("set-cookie", AUTH_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + cookieSecurityAttribute());
    return json(res, 200, { ok: true });
  }
  const session = ACCESS_PASSWORD ? await sessionFor(req) : null;
  if (ACCESS_PASSWORD && !session) {
    if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "Sesiunea a expirat. Autentifică-te din nou." });
    if (req.method === "GET" || req.method === "HEAD") return sendLoginPage(res, req.method === "HEAD");
    return json(res, 401, { error: "Sesiunea a expirat. Autentifică-te din nou." });
  }
  const account = session || { userId: "owner", role: "owner", username: ACCESS_USER || "local" };
  req.novaAccount = account;
  const principal = account.userId || "owner";
  if (req.method === "GET" && url.pathname === "/api/billing/bank-orders") return json(res, 200, await billing.bankOrders(account));
  if (req.method === "POST" && ["/api/billing/bank-transfer", "/api/billing/bank-confirm", "/api/billing/bank-settings"].includes(url.pathname)) {
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de plată respinsă." });
    if (url.pathname.endsWith("/bank-transfer")) return json(res, 200, await billing.bankTransfer(account));
    const body = await readJson(req);
    if (url.pathname.endsWith("/bank-settings")) return json(res, 200, await billing.saveBankSettings(account, body));
    return json(res, 200, await billing.confirmBankTransfer(account, body.reference));
  }
  if (req.method === "GET" && url.pathname === "/api/billing") return json(res, 200, await billing.summary(account, SUBSCRIBER_DAILY_AI_LIMIT));
  if (req.method === "POST" && ["/api/billing/checkout", "/api/billing/portal"].includes(url.pathname)) {
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de plată respinsă." });
    const result = url.pathname.endsWith("/checkout") ? await billing.checkout(account) : await billing.portal(account);
    return json(res, 200, result);
  }
  await refreshAiSettings();
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    if (account.role === "owner") return json(res, 200, { username: account.username, role: account.role, id: account.userId, authEnabled: Boolean(ACCESS_PASSWORD), dailyLimit: null, remainingToday: null });
    const record = (await readAccounts()).users.find(user => user.id === account.userId);
    if (!record) return json(res, 401, { error: "Contul nu mai este disponibil. Autentifică-te din nou." });
    const quota = quotaFor(record, SUBSCRIBER_DAILY_AI_LIMIT);
    return json(res, 200, { username: account.username, role: account.role, id: account.userId, authEnabled: Boolean(ACCESS_PASSWORD), plan: quota.plan, quotaLimit: quota.limit, quotaRemaining: quota.remaining, quotaInterval: quota.interval, dailyLimit: quota.interval === "day" ? quota.limit : null, remainingToday: quota.interval === "day" ? quota.remaining : null });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res, 200, { settings: publicProviderSettings() });
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    if (account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate schimba furnizorul AI al platformei." });
    const body = await readJson(req);
    if (!["ollama", "openai"].includes(body.provider)) return json(res, 400, { error: "Alege Ollama sau OpenAI / compatibil." });
    if (body.clearApiKey === true) aiProvider.apiKey = "";
    else if (typeof body.apiKey === "string" && body.apiKey.trim()) aiProvider.apiKey = body.apiKey.trim().slice(0, 500);
    if (body.provider === "openai") {
      let endpoint;
      try { endpoint = new URL(String(body.baseUrl || "")); }
      catch { return json(res, 400, { error: "Adresa API nu este validă." }); }
      if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        return json(res, 400, { error: "Adresa API trebuie să fie HTTP(S), fără autentificare în URL." });
      }
      aiProvider.baseUrl = endpoint.toString().replace(/\/+$/, "");
      aiProvider.textModel = String(body.textModel || "gpt-4.1-mini").trim().slice(0, 120);
      aiProvider.imageModel = String(body.imageModel || "gpt-image-1-mini").trim().slice(0, 120);
      aiProvider.speechModel = String(body.speechModel || "gpt-4o-mini-tts").trim().slice(0, 120);
      aiProvider.voice = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"].includes(body.voice) ? body.voice : "nova";
      if (!aiProvider.apiKey) return json(res, 400, { error: "Cheia API lipsește. Introdu o cheie sau configureaz-o în secretele serverului." });
    }
    aiProvider.provider = body.provider;
    await persistAiSettings();
    return json(res, 200, { settings: publicProviderSettings(), notice: "Configurarea AI este sincronizată între instanțe; cheia este criptată și nu este returnată în interfață." });
  }

  if (req.method === "POST" && url.pathname === "/api/media/image") {
    try {
      if (aiProvider.provider !== "openai") throw new Error("Selectează furnizorul OpenAI în Configurare AI pentru generarea imaginilor.");
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
      if (!prompt) return json(res, 400, { error: "Descrie imaginea pe care vrei să o creezi." });
      if (!await consumeAiQuota(req, res)) return;
      const result = await openAiJson("/images/generations", {
        method: "POST",
        body: JSON.stringify({ model: aiProvider.imageModel, prompt, size: "1024x1024", n: 1 })
      }, 300000);
      const image = result.data?.[0];
      if (!image?.b64_json && !image?.url) throw new Error("Serviciul nu a returnat o imagine.");
      const format = image.output_format || "png";
      return json(res, 200, { dataUrl: image.b64_json ? `data:image/${format};base64,${image.b64_json}` : image.url, format, model: aiProvider.imageModel });
    } catch (error) { return json(res, error.status || 502, { error: error.message || "Generarea imaginii a eșuat.", providerError: true }); }
  }

  if (req.method === "POST" && url.pathname === "/api/media/speech") {
    try {
      if (aiProvider.provider !== "openai") throw new Error("Selectează furnizorul OpenAI în Configurare AI pentru sinteza vocală.");
      const body = await readJson(req);
      const input = typeof body.text === "string" ? body.text.trim().slice(0, 4096) : "";
      if (!input) return json(res, 400, { error: "Adaugă text pentru voice-over." });
      if (!await consumeAiQuota(req, res)) return;
      const speech = await openAiBytes("/audio/speech", {
        model: aiProvider.speechModel,
        voice: aiProvider.voice,
        input,
        response_format: "mp3",
        ...(aiProvider.speechModel.startsWith("gpt-4o-mini-tts") ? { instructions: "Vorbește clar, natural și expresiv în limba textului." } : {})
      }, 300000);
      return json(res, 200, { dataUrl: `data:${speech.mime};base64,${speech.base64}`, model: aiProvider.speechModel });
    } catch (error) { return json(res, error.status || 502, { error: error.message || "Generarea vocii a eșuat.", providerError: true }); }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/test") {
    const body = await readJson(req);
    const model = String(body.model || aiProvider.textModel || "").trim().slice(0, 120);
    if (!model) return json(res, 400, { connected: false, error: "Alege un model AI înainte de test." });
    if (aiProvider.provider === "openai" && !aiProvider.apiKey) {
      return json(res, 503, { connected: false, provider: "openai", error: "Cheia API OpenAI lipsește din configurarea serverului." });
    }
    if (!await consumeAiQuota(req, res)) return;
    try {
      const messages = [{ role: "user", content: "Răspunde doar cu: Nova este conectată." }];
      const response = aiProvider.provider === "openai"
        ? await openAiJson("/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model, messages, max_completion_tokens: 24 })
        }, 30000)
        : await ollamaJson("/api/chat", {
          method: "POST",
          body: JSON.stringify({ model, stream: false, messages, options: { num_predict: 24 } })
        });
      const message = aiProvider.provider === "openai" ? response.choices?.[0]?.message : response.message;
      const reply = String(message?.content || "").trim();
      if (!reply) throw new Error("Modelul nu a returnat text.");
      return json(res, 200, { connected: true, provider: aiProvider.provider, model: response.model || model, reply: reply.slice(0, 240) });
    } catch (error) {
      console.error("Nova AI connection test failed:", error);
      const status = error.status;
      const message = aiProvider.provider === "openai"
        ? status === 401 || status === 403
          ? "OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render."
          : status === 429
            ? "OpenAI a limitat cererea de test. Verifică limitele și facturarea API."
            : "Modelul OpenAI nu a putut răspunde. Verifică modelul, accesul API și limitele contului."
        : "Modelul Ollama nu a putut răspunde. Verifică dacă serviciul și modelul sunt pornite.";
      return json(res, 502, { connected: false, provider: aiProvider.provider, error: message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = [];
    const projectsDir = workspacePaths(principal).projects;
    await dataFs.promises.mkdir(projectsDir, { recursive: true });
    for (const entry of await dataFs.promises.readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
      let name = entry.name;
      try { name = JSON.parse(await dataFs.promises.readFile(path.join(projectsDir, entry.name, ".nova-project.json"), "utf8")).name || name; } catch {}
      projects.push({ id: entry.name, name });
    }
    return json(res, 200, { projects: projects.sort((a, b) => a.name.localeCompare(b.name)) });
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    const originalName = typeof body.name === "string" ? body.name.trim() : "";
    if (!originalName || originalName.length > 80) return json(res, 400, { error: "Numele proiectului trebuie să aibă între 1 și 80 de caractere." });
    if (account.role === "subscriber") {
      const currentProjects = await dataFs.promises.readdir(workspacePaths(principal).projects).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
      if (currentProjects.length >= 10) return json(res, 403, { error: "Un cont de abonat poate avea cel mult 10 proiecte." });
    }
    const slug = originalName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "proiect";
    let id = slug;
    const paths = workspacePaths(principal);
    await dataFs.promises.mkdir(paths.trash, { recursive: true });
    while (await pathExists(path.join(paths.projects, id)) || (await dataFs.promises.readdir(paths.trash)).some(name => name.startsWith(`${id}.`))) id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const root = projectRoot(id, principal);
    await dataFs.promises.mkdir(path.join(root, "src"), { recursive: true });
    await dataFs.promises.writeFile(path.join(root, ".nova-project.json"), JSON.stringify({ name: originalName }, null, 2), "utf8");
    if (body.empty !== true) {
      await dataFs.promises.writeFile(path.join(root, "README.md"), `# ${originalName}\n\nProiect creat în Nova AI Studio.\n`, "utf8");
      await dataFs.promises.writeFile(path.join(root, "src", "index.js"), `// Începe să construiești ${originalName}.\n\nfunction main() {\n  console.log("Salut, Nova!");\n}\n\nmain();\n`, "utf8");
      await dataFs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ name: id, version: "0.1.0", private: true }, null, 2) + "\n", "utf8");
    }
    return json(res, 201, { project: { id, name: originalName } });
  }

  if (req.method === "POST" && url.pathname === "/api/project/rename") {
    const body = await readJson(req);
    const root = projectRoot(body.project, principal);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return json(res, 400, { error: "Numele trebuie să aibă între 1 și 80 de caractere." });
    await dataFs.promises.writeFile(path.join(root, ".nova-project.json"), JSON.stringify({ name: body.name.trim() }, null, 2), "utf8");
    return json(res, 200, { id: body.project, name: body.name.trim() });
  }

  if (req.method === "POST" && url.pathname === "/api/project/delete") {
    const body = await readJson(req);
    const paths = workspacePaths(principal);
    const root = projectRoot(body.project, principal);
    const stat = await dataFs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return json(res, 400, { error: "Proiectul nu este un dosar local obișnuit." });
    await dataFs.promises.mkdir(paths.trash, { recursive: true });
    const trashed = path.join(paths.trash, `${body.project}.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.deleted`);
    await dataFs.promises.rename(root, trashed);
    return json(res, 200, { id: body.project, deleted: true });
  }

  if (req.method === "GET" && url.pathname === "/api/projects/trash") {
    const projects = [];
    const trashDir = workspacePaths(principal).trash;
    await dataFs.promises.mkdir(trashDir, { recursive: true });
    for (const entry of await dataFs.promises.readdir(trashDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^([a-z0-9][a-z0-9-]{0,63})\.(\d+-[a-z0-9]+)\.deleted$/);
      if (!match) continue;
      let name = match[1];
      try { name = JSON.parse(await dataFs.promises.readFile(path.join(trashDir, entry.name, ".nova-project.json"), "utf8")).name || name; } catch {}
      projects.push({ id: match[1], name, trashed: entry.name });
    }
    return json(res, 200, { projects: projects.sort((a, b) => b.trashed.localeCompare(a.trashed)) });
  }

  if (req.method === "POST" && url.pathname === "/api/project/restore") {
    const body = await readJson(req);
    if (!validProjectId(body.project)) return json(res, 400, { error: "Proiect invalid." });
    const paths = workspacePaths(principal);
    await dataFs.promises.mkdir(paths.trash, { recursive: true });
    const root = projectRoot(body.project, principal);
    if (await pathExists(root)) return json(res, 409, { error: "Există deja un proiect cu acest identificator." });
    const prefix = `${body.project}.`;
    const entries = (await dataFs.promises.readdir(paths.trash, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix) && entry.name.endsWith(".deleted"))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (!entries.length) return json(res, 404, { error: "Nu există un proiect șters care poate fi restaurat." });
    await dataFs.promises.rename(path.join(paths.trash, entries[0].name), root);
    return json(res, 200, { id: body.project, restored: true });
  }

  if (req.method === "GET" && url.pathname === "/api/project/export") {
    const project = url.searchParams.get("project");
    const root = projectRoot(project, principal);
    const files = await listProjectFiles(root);
    let total = 0;
    const contents = [];
    for (const file of files) {
      const content = await readProjectFile(project, file.path, principal);
      total += Buffer.byteLength(content, "utf8");
      if (total > 8 * 1024 * 1024) return json(res, 413, { error: "Exportul depășește limita de 8 MiB." });
      contents.push({ path: file.path, content });
    }
    let name = project;
    try { name = JSON.parse(await dataFs.promises.readFile(path.join(root, ".nova-project.json"), "utf8")).name || name; } catch {}
    return json(res, 200, { format: "nova-project", version: 1, name, files: contents });
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    const project = url.searchParams.get("project");
    const files = await listProjectFiles(projectRoot(project, principal));
    return json(res, 200, { files });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const project = url.searchParams.get("project");
    const name = url.searchParams.get("path");
    const content = await readProjectFile(project, name, principal);
    return json(res, 200, { path: name, content });
  }

  if (req.method === "PUT" && url.pathname === "/api/file") {
    const body = await readJson(req);
    const result = await writeProjectFile(body.project, body.path, body.content, principal);
    return json(res, 200, result);
  }

  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const project = url.searchParams.get("project");
    const name = url.searchParams.get("path");
    const target = projectFile(project, name, principal);
    await assertProjectParent(target);
    const stat = await dataFs.promises.lstat(target.full);
    if (!stat.isFile() || stat.isSymbolicLink()) return json(res, 400, { error: "Poți elimina numai fișiere obișnuite." });
    const trashFile = path.join(workspacePaths(principal).backups, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.deleted`;
    await dataFs.promises.mkdir(path.dirname(trashFile), { recursive: true });
    await dataFs.promises.rename(target.full, trashFile);
    return json(res, 200, { path: target.relative, deleted: true });
  }

  if (req.method === "POST" && url.pathname === "/api/undo") {
    const body = await readJson(req);
    const paths = workspacePaths(principal);
    const target = projectFile(body.project, body.path, principal);
    const backupBase = path.join(paths.backups, body.project, ...target.relative.split("/"));
    const backupDir = path.dirname(backupBase);
    const prefix = `${path.basename(backupBase)}.`;
    let backups = [];
    try { backups = (await dataFs.promises.readdir(backupDir)).filter(name => name.startsWith(prefix) && /\.(bak|deleted|created)$/.test(name)).sort().reverse(); } catch {}
    if (!backups.length) return json(res, 404, { error: "Nu există o versiune anterioară pentru acest fișier." });
    const backupFile = path.join(backupDir, backups[0]);
    await dataFs.promises.mkdir(path.dirname(target.full), { recursive: true });
    await assertProjectParent(target);
    if (backupFile.endsWith(".created")) {
      try { await dataFs.promises.unlink(target.full); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await dataFs.promises.unlink(backupFile);
      return json(res, 200, { path: target.relative, reverted: true });
    }
    try {
      const current = await dataFs.promises.lstat(target.full);
      if (current.isSymbolicLink() || !current.isFile()) throw Object.assign(new Error("Ținta nu este un fișier obișnuit."), { status: 400 });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await dataFs.promises.copyFile(backupFile, target.full);
    await dataFs.promises.unlink(backupFile);
    return json(res, 200, { path: target.relative, restored: true });
  }

  if (req.method === "POST" && url.pathname === "/api/agent") {
    const body = await readJson(req);
    if (typeof body.model !== "string" || !body.model.trim()) return json(res, 400, { error: "Alege un model AI în bara de chat." });
    if (!validProjectId(body.project)) return json(res, 400, { error: "Alege un proiect." });
    if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: "Trimite o cerere agentului." });
    const mode = ["build", "plan", "review"].includes(body.mode) ? body.mode : "build";
    let inputBudget = account.role === "subscriber" ? 18000 : 288000;
    const safeMessages = body.messages.slice(account.role === "subscriber" ? -6 : -12).map(message => {
      if (!(["user", "assistant"].includes(message.role)) || typeof message.content !== "string") throw Object.assign(new Error("Format de conversație invalid."), { status: 400 });
      const limit = account.role === "subscriber" ? 6000 : 24000;
      const content = message.content.slice(0, Math.min(limit, inputBudget));
      inputBudget -= content.length;
      return { role: message.role, content };
    });
    const task = ["auto", "code", "lyrics", "music", "video"].includes(body.task) ? body.task : "auto";
    if (!await consumeAiQuota(req, res)) return;
    try {
      const result = await runAgent(body.model.trim(), safeMessages, body.project, mode, body.allowChanges === true && mode === "build", task, principal);
      return json(res, 200, result);
    } catch (error) {
      console.error("Nova AI agent provider failed:", error);
      const unavailable = aiProvider.provider === "ollama"
        ? "Modelul AI local (Ollama) nu este disponibil pe server. Configurează furnizorul OpenAI în setările Nova."
        : !aiProvider.apiKey
          ? "Cheia API OpenAI lipsește. Configurează furnizorul AI în setările Nova."
          : "Furnizorul AI nu a putut procesa cererea. Verifică modelul și configurarea API.";
      return json(res, 503, { error: unavailable });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    if (aiProvider.provider === "openai") {
      if (!aiProvider.apiKey) {
        return json(res, 200, {
          connected: false,
          provider: "openai",
          error: "Cheia API OpenAI lipsește din configurarea serverului.",
          models: []
        });
      }
      try {
        // Validate the server-side credential without generating content or using model tokens.
        await openAiJson("/models", {}, 10000);
      } catch (error) {
        const status = error.status;
        const message = status === 401 || status === 403
          ? "OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render."
          : status === 429
            ? "OpenAI a limitat verificarea. Verifică limitele și facturarea API, apoi reîncearcă."
            : status === 404
              ? "Adresa API nu oferă ruta /models. Verifică OPENAI_BASE_URL."
              : "Serverul nu a putut valida conexiunea OpenAI. Verifică rețeaua și configurarea API.";
        return json(res, 200, { connected: false, provider: "openai", error: message, models: [] });
      }
      return json(res, 200, {
        connected: true,
        provider: "openai",
        version: "Conexiune verificată",
        models: aiProvider.textModel ? [aiProvider.textModel] : []
      });
    }
    try {
      const [version, tags] = await Promise.all([
        ollamaJson("/api/version"),
        ollamaJson("/api/tags")
      ]);
      return json(res, 200, {
        connected: true,
        provider: "ollama",
        version: version.version || "local",
        models: (tags.models || []).map(item => item.name)
      });
    } catch (error) {
      return json(res, 200, { connected: false, error: error.message, models: [] });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readJson(req);
      if (typeof body.model !== "string" || !body.model.trim()) {
        return json(res, 400, { error: "Alege un model Ollama înainte să trimiți mesajul." });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, { error: "Adaugă un mesaj pentru model." });
      }

      let inputBudget = account.role === "subscriber" ? 18000 : 288000;
      const messages = body.messages.slice(account.role === "subscriber" ? -6 : -12).map(message => {
        if (!(["user", "assistant"].includes(message.role)) || typeof message.content !== "string") {
          throw Object.assign(new Error("Format de mesaj invalid."), { status: 400 });
        }
        const limit = account.role === "subscriber" ? 6000 : 24000;
        const content = message.content.slice(0, Math.min(limit, inputBudget));
        inputBudget -= content.length;
        return { role: message.role, content };
      });
      if (!await consumeAiQuota(req, res)) return;

      const result = await providerChat(body.model.trim(), [
            {
              role: "system",
              content: "Ești Nova, un asistent de programare care rulează local. Ajută la analizarea și scrierea codului. Când propui modificări, oferă blocuri de cod complete cu etichete de limbaj și numele fișierului. Nu pretinde că ai schimbat fișiere sau ai rulat comenzi; nu ai acces la sistemul de fișiere ori la terminal. Menționează clar presupunerile și riscurile relevante. Răspunde în limba utilizatorului."
            },
            ...messages
          ], undefined, account.role === "subscriber" ? 1500 : null);
      return json(res, 200, {
        content: result.message?.content || "Modelul nu a returnat text.",
        model: result.model || body.model,
        done: true
      });
    } catch (error) {
      return json(res, error.status || 502, { error: error.message || "Nu am putut contacta Ollama." });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "Metodă HTTP neacceptată." });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: "Calea URL nu este validă." });
  }
  if (pathname === "/admin.html" && account.role !== "owner") {
    res.writeHead(302, { location: "/", "cache-control": "no-store" });
    return res.end();
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return json(res, 403, { error: "Calea solicitată nu este permisă." });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Pagina nu a fost găsită.");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache"
    });
    if (req.method === "HEAD") return res.end();
    res.end(data);
  });
}

const appServer = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    // Keep internal paths, API credentials and provider details out of HTTP responses.
    console.error("Nova request failed:", error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    json(res, status, { error: status === 500 ? "Eroare internă. Încearcă din nou." : (error.message || "Cerere invalidă.") });
  });
});

appServer.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Portul ${PORT} este deja folosit.`);
    console.error(`Dacă Nova rulează deja, deschide http://${HOST}:${PORT} în browser.`);
    console.error(`Pentru a porni pe alt port, setează variabila PORT (de exemplu PORT=4174).`);
  } else {
    console.error("Nova AI Studio nu a putut porni:", error.message);
  }
  process.exitCode = 1;
});

async function startNova() {
  await dataStore.init(DATA_DIR);
  dataFs = dataStore.filesystem(DATA_DIR);
  await dataFs.promises.mkdir(PROJECTS_DIR, { recursive: true });
  await dataFs.promises.mkdir(BACKUPS_DIR, { recursive: true });
  await dataFs.promises.mkdir(PROJECT_TRASH_DIR, { recursive: true });
  await refreshAiSettings(true);
  appServer.listen(PORT, HOST, () => {
    console.log(`Nova AI Studio rulează la http://${HOST}:${PORT}`);
    console.log(`Ollama: ${OLLAMA}`);
    console.log(`Storage: ${dataStore.enabled ? "PostgreSQL shared" : "local filesystem"}`);
  });
}

startNova().catch(error => {
  console.error("Nova AI Studio could not initialize persistent storage:", error.message);
  process.exitCode = 1;
});

