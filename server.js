const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const dataStore = require("./data-store");
const { createProviderStatus } = require("./provider-status");
const providerStatus = createProviderStatus();
const { creationPrompts } = require("./creation-prompts");
const { requiredFiles: requiredBusinessFiles, businessProjectName, validateBusinessFiles, addBusinessContact, contactScript: businessContactScript, normalizeBusinessContact } = require("./business-site");
const { accuracyPrompt, collectSources, answerWithSources, speechOptions, automaticWebSearch, needsWebRetry } = require("./ai-quality");
const { createBilling, quotaFor, consumeQuota } = require("./billing");
const { createGoogleAuth } = require("./google-auth");
const { createRestaurantService, isRestaurantMarketplaceIdea } = require("./restaurants");
const {
  PLATFORM_PRESETS,
  createProfilesFromEnv,
  sanitizeProfileUpdate,
  isProfileConfigured,
  listProfileModels,
  listProfileImageModels,
  generateProfileImage,
  chatWithProfile,
  openAiCompatibleJson,
  openAiCompatibleBytes,
  openAiCompatibleImageEdit,
  isTransientProviderError
} = require("./ai-providers");
let dataFs = fs;

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DATA_DIR = process.env.NOVA_DATA_DIR || __dirname;
const ACCESS_USER = process.env.NOVA_ACCESS_USER || "";
const ACCESS_PASSWORD = process.env.NOVA_ACCESS_PASSWORD || "";
const DEFAULT_TEXT_MODEL = PLATFORM_PRESETS.openai.textModel;
const DEFAULT_IMAGE_MODEL = PLATFORM_PRESETS.openai.imageModel;
const AI_SETTINGS_SCHEMA_VERSION = 5;
const configuredAiProvider = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
const environmentProfiles = createProfilesFromEnv({ ...process.env, OLLAMA_URL: process.env.OLLAMA_URL || OLLAMA });
const environmentProfileMap = Object.fromEntries(environmentProfiles.map(profile => [profile.id, profile]));

function canonicalConfiguredPlatform(value) {
  const aliases = { google: "gemini", claude: "anthropic", compatible: "custom", "openai-compatible": "custom" };
  const requested = aliases[value] || value;
  if (requested === "openai" && environmentProfileMap.custom?.baseUrl && process.env.OPENAI_BASE_URL) return "custom";
  return environmentProfileMap[requested] ? requested : "";
}

function initialTextPlatform() {
  const requested = canonicalConfiguredPlatform(configuredAiProvider);
  if (requested) return requested;
  const configured = environmentProfiles.find(profile => profile.id !== "ollama" && isProfileConfigured(profile));
  if (configured) return configured.id;
  return process.env.NODE_ENV === "production" ? "openai" : "ollama";
}

function parseFallbackPlatforms(value) {
  return [...new Set(String(value || "").split(",").map(item => canonicalConfiguredPlatform(item.trim().toLowerCase())).filter(Boolean))];
}

function firstMediaPlatform(capability, preferred) {
  for (const id of [preferred, "openai", "gemini", "openrouter", "custom"]) {
    const profile = environmentProfileMap[id];
    if (routeProfileConfigured(profile, capability)) return id;
  }
  return "openai";
}

const initialPlatform = initialTextPlatform();
let aiConfig = {
  schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
  profiles: environmentProfileMap,
  routes: {
    text: initialPlatform,
    image: firstMediaPlatform("image", initialPlatform),
    speech: firstMediaPlatform("speech", initialPlatform),
    autoSelect: true,
    autoImageSelect: process.env.AI_IMAGE_AUTO_SELECT !== "false",
    autoFallback: parseFallbackPlatforms(process.env.AI_FALLBACK_PROVIDERS).length > 0,
    fallbacks: parseFallbackPlatforms(process.env.AI_FALLBACK_PROVIDERS)
  },
  search: {
    provider: ["auto", "bing", "brave", "tavily"].includes(String(process.env.WEB_SEARCH_PROVIDER || "auto").toLowerCase())
      ? String(process.env.WEB_SEARCH_PROVIDER || "auto").toLowerCase()
      : "auto",
    keys: {
      brave: String(process.env.BRAVE_SEARCH_API_KEY || "").trim(),
      tavily: String(process.env.TAVILY_API_KEY || "").trim()
    }
  }
};
const PUBLIC_DIR = path.join(__dirname, "public");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const BACKUPS_DIR = path.join(DATA_DIR, "data", "backups");
const PROJECT_TRASH_DIR = path.join(DATA_DIR, "data", "project-trash");
const ACCOUNTS_FILE = path.join(DATA_DIR, "data", "subscriber-accounts.json");
const PUBLICATIONS_FILE = path.join(DATA_DIR, "data", "published-sites.json");
const MAX_ACCOUNTS = Math.max(1, Math.min(10000, Number.parseInt(process.env.NOVA_MAX_ACCOUNTS || "100", 10) || 100));
const SUBSCRIBER_DAILY_AI_LIMIT = Math.max(1, Math.min(5, Number.parseInt(process.env.NOVA_SUBSCRIBER_DAILY_AI_LIMIT || "5", 10) || 5));
const MAX_BODY = 1024 * 1024;
const MAX_CREATION_WIRE_BODY = Math.ceil(MAX_BODY / 3) * 4 + 128;
const MAX_IMAGE_EDIT_BODY = 12 * 1024 * 1024;
const MAX_IMAGE_UPLOAD = 8 * 1024 * 1024;
const MAX_FILE = 512 * 1024;

if (!new Set(["127.0.0.1", "localhost", "::1"]).has(HOST) && (!ACCESS_USER || ACCESS_PASSWORD.length < 20 || /^(replace-|change-me|changeme)/i.test(ACCESS_PASSWORD))) {
  throw new Error("Public binding needs NOVA_ACCESS_USER and a unique NOVA_ACCESS_PASSWORD of at least 20 characters; replace the example value first.");
}

const AUTH_COOKIE = "nova_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let accountQueue = Promise.resolve();
let publicationQueue = Promise.resolve();
let aiSettingsCacheExpiresAt = 0;
let aiSettingsRevision = 0;
let aiHealthCache = null;
let aiHealthPending = null;
let automaticProviderCursor = 0;
const googleAuth = createGoogleAuth({
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  redirectUri: process.env.GOOGLE_REDIRECT_URI || "",
  cookieSecret: process.env.NOVA_DATA_ENCRYPTION_KEY || ACCESS_PASSWORD,
  secureCookies: Boolean(cookieSecurityAttribute())
});
const LOGIN_PAGE = `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#07101b"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Nova"><meta name="description" content="Nova AI Studio — chat AI pentru cod, imagini, texte, voice-over și afaceri online."><link rel="canonical" href="https://www.nova-ai-studio.eu/"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png"><meta property="og:type" content="website"><meta property="og:locale" content="ro_RO"><meta property="og:site_name" content="Nova AI Studio"><meta property="og:title" content="Nova AI Studio — transformă ideile în proiecte"><meta property="og:description" content="Creează cod, imagini, texte și site-uri publicabile într-un singur studio AI online."><meta property="og:url" content="https://www.nova-ai-studio.eu/"><meta property="og:image" content="https://www.nova-ai-studio.eu/share-image.png"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1920"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Nova AI Studio"><meta name="twitter:description" content="Cod, imagini, texte și afaceri online într-un singur studio AI."><meta name="twitter:image" content="https://www.nova-ai-studio.eu/share-image.png"><title>Nova AI Studio · Acces</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Nova AI Studio","url":"https://www.nova-ai-studio.eu/","applicationCategory":"BusinessApplication","operatingSystem":"Web","description":"Studio AI online pentru cod, imagini, texte, voice-over și afaceri online.","offers":{"@type":"Offer","price":"0","priceCurrency":"EUR"}}</script><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#050a0e;color:#edfaff}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 65% 15%,#123c4c55,transparent 60%),#050a0e}.card{width:min(100%,420px);padding:32px;border:1px solid #28495a;border-radius:22px;background:#0b171ff2;box-shadow:0 24px 80px #0008}.mark{display:grid;place-items:center;width:46px;height:46px;border:1px solid #3f8aa1;border-radius:50%;background:#102a37;color:#8ce9ff;font-weight:700;font-size:23px}h1{margin:22px 0 8px;font-size:26px;letter-spacing:-.04em}p{margin:0 0 24px;color:#8faab7;line-height:1.6;font-size:14px}.benefit{margin:-8px 0 22px;padding:12px 14px;border:1px solid #285244;border-radius:12px;background:#0c211e;color:#b6f2df;font-size:13px;line-height:1.5}label{display:block;margin:18px 0 8px;font-size:13px;color:#c7dce6}input{width:100%;height:48px;padding:0 14px;border:1px solid #315064;border-radius:11px;background:#08121b;color:#fff;font:inherit;outline:none}input:focus{border-color:#60d9fa;box-shadow:0 0 0 3px #60d9fa18}.password-field{position:relative}.password-field input{padding-right:54px}.password-toggle{position:absolute;right:7px;top:7px;display:grid;place-items:center;width:36px;height:34px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:#8faab7;cursor:pointer}.password-toggle:hover{background:#ffffff0d;color:#edfaff}.password-toggle:focus-visible{outline:2px solid #60d9fa;outline-offset:1px}.password-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.password-hint{display:block;margin-top:8px;color:#8faab7;font-size:12px;line-height:1.6}button{width:100%;height:48px;margin-top:22px;border:0;border-radius:11px;background:linear-gradient(120deg,#79e7ff,#37b7dd);color:#03212c;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.switch{display:block;width:auto;height:auto;margin:16px auto 0;padding:4px;background:transparent;color:#9bdded;font:inherit;text-decoration:underline;font-size:13px}.status{min-height:22px;margin:14px 0 0;color:#ffaaa9;font-size:13px;line-height:1.6}.status.ok{color:#91ead1}footer{margin-top:24px;color:#7195a5;font-size:12px;text-align:center;line-height:1.8}footer a{color:#9bdded}.google-login{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;min-height:46px;padding:10px 14px;margin-top:20px;border:1px solid #36556a;border-radius:11px;background:#10232e;color:#e8f7ff;font-size:14px;text-decoration:none}.google-login:hover{border-color:#60d9fa}.google-symbol{font-size:18px;font-weight:700;color:#8edff6}[hidden]{display:none!important}@media(max-width:420px){body{padding:16px}.card{padding:26px 22px}}
</style></head><body><main class="card"><div class="mark" aria-hidden="true">N</div><h1>Nova AI Studio</h1><p id="subtitle">Conectează-te pentru a deschide spațiul tău Nova.</p><div id="benefit" class="benefit" hidden>Cont fără taxă de înscriere · __AI_LIMIT__ cereri AI pe zi. După înregistrare intri direct în aplicație.</div><form id="auth-form"><label for="username">Utilizator</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="32" required autofocus><label for="password">Parolă</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required><button class="password-toggle" type="button" data-password-toggle="password" aria-label="Afișează parola" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle><path data-password-slash d="M3 3l18 18" style="display:none"></path></svg></button></div><small id="password-hint" class="password-hint" hidden>Între 1 și 8 caractere, alese de tine. Fără cerințe de majuscule, cifre sau simboluri.</small><button id="submit" type="submit">Autentificare</button><button id="switch" class="switch" type="button">Creează un cont de abonat</button><div id="status" class="status" role="status" aria-live="polite"></div></form><a id="google-login" class="google-login" href="/api/auth/google" __GOOGLE_LOGIN_HIDDEN__><span class="google-symbol" aria-hidden="true">G</span>Continuă cu Google</a><a id="android-download" class="google-login" href="/downloads/android">Android · Descarcă APK ↓</a><button id="install-nova" class="switch" type="button">iPhone/iPad · Instalează din Safari</button><button id="share-nova" class="switch" type="button">Distribuie Nova ↗</button><footer><a href="/about">Despre Nova</a> · <a href="/plans.html">Abonamente 9,99 €/lună</a><br>Sesiune protejată · Nova AI Studio</footer></main><script>
const form=document.getElementById("auth-form"),button=document.getElementById("submit"),status=document.getElementById("status"),password=document.getElementById("password"),switchButton=document.getElementById("switch"),benefit=document.getElementById("benefit"),passwordHint=document.getElementById("password-hint"),toggle=document.querySelector("[data-password-toggle]");let registering=false;
function resetPasswordVisibility(){password.type="password";toggle.setAttribute("aria-pressed","false");toggle.setAttribute("aria-label","Afișează parola");toggle.querySelector("[data-password-slash]").style.display="none";}
toggle.addEventListener("click",()=>{const visible=password.type==="password";password.type=visible?"text":"password";toggle.setAttribute("aria-pressed",String(visible));toggle.setAttribute("aria-label",visible?"Ascunde parola":"Afișează parola");toggle.querySelector("[data-password-slash]").style.display=visible?"block":"none";});
const iosInstallMessage="Pe iPhone/iPad: deschide această pagină în Safari, apasă butonul Partajare (pătratul cu săgeată în sus), apoi «Adăugați la ecranul principal».";document.getElementById("install-nova").addEventListener("click",()=>{status.textContent=navigator.standalone?"Nova este deja instalată pe acest dispozitiv.":iosInstallMessage;status.classList.add("ok");});if(new URLSearchParams(location.search).get("install")==="ios"){status.textContent=iosInstallMessage;status.classList.add("ok");}if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/service-worker.js").catch(()=>{}));document.getElementById("share-nova").addEventListener("click",async()=>{const data={title:"Nova AI Studio",text:"Creează cod, imagini, texte și site-uri cu Nova AI Studio.",url:"https://www.nova-ai-studio.eu/"};try{if(navigator.share)await navigator.share(data);else{await navigator.clipboard.writeText(data.url);status.textContent="Linkul Nova a fost copiat. Îl poți lipi pe Facebook, Instagram sau TikTok.";status.classList.add("ok");}}catch(error){if(error.name!=="AbortError")status.textContent="Copiază linkul: "+data.url;}});
if(new URLSearchParams(location.search).get("auth")==="google-failed")status.textContent="Conectarea cu Google nu a reușit. Poți reîncerca sau folosi utilizatorul și parola.";
if(new URLSearchParams(location.search).get("session")==="expired")status.textContent="Sesiunea a expirat. Autentifică-te din nou.";
if(new URLSearchParams(location.search).get("account")==="deleted"){status.textContent="Contul și datele sale au fost șterse definitiv.";status.classList.add("ok");}
switchButton.addEventListener("click",()=>{registering=!registering;status.textContent="";status.classList.remove("ok");password.value="";resetPasswordVisibility();document.getElementById("subtitle").textContent=registering?"Alege un utilizator și parola dorită. Intri direct în Nova.":"Conectează-te pentru a deschide spațiul tău Nova.";button.textContent=registering?"Creează cont și intră":"Autentificare";switchButton.textContent=registering?"Am deja cont · Autentificare":"Creează un cont de abonat";benefit.hidden=!registering;passwordHint.hidden=!registering;password.autocomplete=registering?"new-password":"current-password";if(registering){password.minLength=1;password.maxLength=8;}else{password.removeAttribute("minlength");password.maxLength=128;}});
form.addEventListener("submit",async event=>{event.preventDefault();if(registering&&password.value.length>8){status.textContent="Alege o parolă de maximum 8 caractere.";password.focus();return;}button.disabled=true;switchButton.disabled=true;status.textContent="";status.classList.remove("ok");try{const response=await fetch(registering?"/api/auth/register":"/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({username:document.getElementById("username").value,password:password.value})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"Cererea nu a putut fi finalizată.");password.value="";if(registering){status.textContent="Cont creat. Se deschide Nova…";status.classList.add("ok");}window.location.replace("/");}catch(error){status.textContent=error.message||"Nu s-a putut realiza autentificarea.";button.disabled=false;switchButton.disabled=false;password.focus();}});
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
  if (session.role !== "subscriber") return session;
  const record = (await readAccounts()).users.find(user => user.id === session.userId);
  if (!record) return null;
  return { ...session, username: record.username, deleting: Boolean(record.deleting) };
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

async function createVerifiedSession(res, account) {
  if (account.role !== "subscriber") return createSession(res, account);
  return withAccountsLock(async () => {
    const record = (await readAccounts()).users.find(user => user.id === account.userId);
    if (!record) return false;
    return createSession(res, { userId: record.id, role: "subscriber", username: record.username });
  });
}

function sendLoginPage(res, headOnly = false) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  res.end(headOnly ? "" : LOGIN_PAGE.replace("__AI_LIMIT__", String(SUBSCRIBER_DAILY_AI_LIMIT)).replace("__GOOGLE_LOGIN_HIDDEN__", ACCESS_PASSWORD && googleAuth.enabled ? "" : "hidden"));
}

function sendPendingDeletionPage(res, account, headOnly = false) {
  const username = JSON.stringify(account.username).replaceAll("<", "\\u003c");
  const page = `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Finalizează ștergerea · Nova</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#050a0e;color:#edfaff;font:16px/1.6 system-ui}.card{width:min(100%,440px);padding:30px;border:1px solid #583b35;border-radius:20px;background:#0b171f}h1{margin-top:0;font-size:25px}p{color:#a9bac3}button{width:100%;min-height:48px;border:0;border-radius:11px;background:#ffaaa9;color:#351216;font:inherit;font-weight:750;cursor:pointer}.status{min-height:24px;margin-top:14px;color:#ffcbc9}</style></head><body><main class="card"><h1>Finalizează ștergerea contului</h1><p>Contul este blocat pentru a preveni modificarea datelor în timpul ștergerii. Apasă butonul pentru a relua operația în siguranță.</p><button id="retry" type="button">Finalizează ștergerea</button><div id="status" class="status" role="status"></div></main><script>const username=${username},button=document.getElementById("retry"),status=document.getElementById("status");button.addEventListener("click",async()=>{button.disabled=true;status.textContent="Se finalizează…";try{const response=await fetch("/api/auth/account",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({confirmation:username})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||"Ștergerea nu a putut fi finalizată.");location.replace("/?account=deleted");}catch(error){status.textContent=error.message;button.disabled=false;}});</script></body></html>`;
  res.writeHead(423, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" });
  res.end(headOnly ? "" : page);
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
  if (!await createVerifiedSession(res, account)) return json(res, 503, { error: "Sesiunea nu a putut fi creată. Reîncearcă." });
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
  if (!await createVerifiedSession(res, account)) return json(res, 503, { error: "Contul a fost creat, dar sesiunea nu a putut fi creată. Autentifică-te." });
  return json(res, 201, { ok: true });
}

async function accountForGoogle(identity) {
  return withAccountsLock(async () => {
    const database = await readAccounts();
    let record = database.users.find(user => user.googleSub === identity.sub);
    if (record?.deleting) return { userId: record.id, role: "subscriber", username: record.username };
    if (!record) {
      if (database.users.length >= MAX_ACCOUNTS) throw Object.assign(new Error("Înregistrările sunt momentan închise."), { status: 503 });
      let username;
      do { username = "google_" + crypto.randomBytes(10).toString("hex"); }
      while (database.users.some(user => user.usernameKey === username) || normalizedUsername(ACCESS_USER) === username);
      record = { id: crypto.randomBytes(16).toString("hex"), username, usernameKey: username, googleSub: identity.sub, usageDate: "", usageCount: 0, createdAt: new Date().toISOString() };
      database.users.push(record);
    }
    // A Google identity never acquires another account through a matching email/name.
    record.googleEmail = identity.email;
    record.displayName = identity.name || identity.email;
    await writeAccounts(database);
    return { userId: record.id, role: "subscriber", username: record.username };
  });
}

async function googleCallback(req, res, url) {
  try {
    if (!googleAuth.enabled) return json(res, 503, { error: "Conectarea Google nu este configurată." });
    const callback = new URL(process.env.GOOGLE_REDIRECT_URI);
    callback.search = url.search;
    const { identity } = await googleAuth.finish(callback.href, req.headers.cookie);
    const account = await accountForGoogle(identity);
    if (!await createVerifiedSession(res, account)) throw new Error("Sesiunea nu a putut fi creată.");
    const sessionCookie = res.getHeader("set-cookie");
    res.setHeader("set-cookie", [googleAuth.clearCookie, ...(Array.isArray(sessionCookie) ? sessionCookie : [sessionCookie])]);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
    // A same-origin document starts the next navigation, preserving Strict session cookies.
    return res.end('<!doctype html><html lang="ro"><meta charset="utf-8"><title>Conectat la Nova</title><p>Conectare reușită. <a href="/">Deschide Nova</a></p><script>location.replace("/")</script></html>');
  } catch {
    res.writeHead(303, { location: "/?auth=google-failed", "set-cookie": googleAuth.clearCookie, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    return res.end();
  }
}

async function consumeAiQuota(req, res, units = 1) {
  const account = req.novaAccount || { userId: "owner", role: "owner", username: ACCESS_USER || "local" };
  if (account.role === "owner") return true;
  try {
    const quota = await withAccountsLock(async () => {
      const database = await readAccounts();
      const record = database.users.find(user => user.id === account.userId);
      if (!record) throw Object.assign(new Error("Contul nu mai este disponibil. Autentifică-te din nou."), { status: 401 });
      if (record.deleting) throw Object.assign(new Error("Ștergerea contului este în curs."), { status: 423 });
      const quota = consumeQuota(record, SUBSCRIBER_DAILY_AI_LIMIT, undefined, units);
      if (quota.allowed) await writeAccounts(database);
      return quota;
    });
    res.setHeader("x-nova-ai-remaining", String(quota.remaining));
    res.setHeader("x-nova-ai-limit", String(quota.limit));
    res.setHeader("x-nova-ai-interval", quota.interval);
    if (!quota.allowed) {
      json(res, 429, { error: units > 1 ? `Vocea necesită ${units} unități AI, dar mai ai ${quota.remaining}. Scurtează textul sau așteaptă reînnoirea cotei. Nu a fost consumată nicio unitate.` : quota.plan === "standard"
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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
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

function readBody(req, maximum = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maximum) {
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

async function readJson(req, maximum = MAX_BODY) {
  const raw = await readBody(req, maximum);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Corpul cererii nu este JSON valid."), { status: 400 }); }
}

async function readCreationJson(req) {
  const raw = await readBody(req, MAX_CREATION_WIRE_BODY);
  let body;
  try { body = JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Corpul cererii nu este JSON valid."), { status: 400 }); }
  if (body?.messagesEncoding === undefined) {
    if (raw.length > MAX_BODY) throw Object.assign(new Error("Cererea este prea mare."), { status: 413 });
    return body;
  }
  const messages = creationMessages(body.messages, "owner", body.messagesEncoding);
  const decoded = { ...body, messages: body.messages.map((message, index) => ({ ...message, content: messages[index].content })) };
  delete decoded.messagesEncoding;
  if (Buffer.byteLength(JSON.stringify(decoded), "utf8") > MAX_BODY) {
    throw Object.assign(new Error("Cererea este prea mare."), { status: 413 });
  }
  return decoded;
}

const billing = createBilling({ readAccounts, writeAccounts, withAccountsLock });

function cloneAiConfig(value = aiConfig) {
  return JSON.parse(JSON.stringify(value));
}

function automaticTextProfiles(config = aiConfig) {
  const selected = config.profiles[config.routes.text];
  return [selected, ...Object.values(config.profiles)]
    .filter((profile, index, profiles) => profile && profiles.findIndex(item => item.id === profile.id) === index)
    .filter(profile => textRoutingEligible(profile, config));
}

function activeTextProfile(config = aiConfig) {
  const selected = config.profiles[config.routes.text];
  if (config.routes.autoSelect !== true) return selected || config.profiles.openai || Object.values(config.profiles)[0];
  return automaticTextProfiles(config)[0] || selected || config.profiles.openai || Object.values(config.profiles)[0];
}

function routeProfile(capability, config = aiConfig) {
  const id = capability === "text" ? config.routes.text : config.routes[capability];
  return config.profiles[id];
}

function localProviderUrl(profile) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(profile?.baseUrl || "").hostname); }
  catch { return false; }
}

function routeProfileConfigured(profile, capability) {
  if (!profile?.baseUrl || !profile.capabilities?.[capability]) return false;
  if ((profile.requiresKey || profile.id === "custom" && !localProviderUrl(profile)) && !profile.apiKey) return false;
  if (capability === "text") return Boolean(profile.textModel);
  if (capability === "image") return Boolean(profile.imageModel);
  if (capability === "speech") return Boolean(profile.speechModel && profile.voice);
  return false;
}

function textRoutingEligible(profile, config = aiConfig) {
  return Boolean(profile && routeProfileConfigured(profile, "text") && (profile.id === config.routes.text || profile.apiKey));
}

function legacyProvider(profile) {
  return profile?.protocol === "ollama" ? "ollama" : "openai";
}

function publicProviderId(profile) {
  return profile?.id === "custom" ? "openai" : profile?.id || "openai";
}

function safePublicProfile(profile, detailed) {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: detailed ? profile.baseUrl : "",
    textModel: profile.textModel,
    imageModel: profile.imageModel,
    speechModel: profile.speechModel,
    voice: profile.voice,
    capabilities: { ...profile.capabilities },
    ready: {
      text: routeProfileConfigured(profile, "text"),
      image: routeProfileConfigured(profile, "image"),
      imageEdit: routeProfileConfigured(profile, "image") && profile.capabilities.imageEdit === true,
      speech: routeProfileConfigured(profile, "speech")
    },
    requiresKey: profile.requiresKey,
    apiKeyConfigured: Boolean(profile.apiKey),
    configured: isProfileConfigured(profile),
    textRoutingEligible: textRoutingEligible(profile),
    status: providerStatus.get(profile)
  };
}

function publicProviderSettings(role = "owner") {
  const active = activeTextProfile();
  const visibleIds = role === "owner"
    ? Object.keys(aiConfig.profiles)
    : [...new Set([aiConfig.routes.text, aiConfig.routes.image, aiConfig.routes.speech])];
  return {
    // Legacy fields remain available for older Nova clients.
    provider: legacyProvider(active),
    platform: active.id,
    platformName: active.name,
    baseUrl: role === "owner" ? active.baseUrl : "",
    textModel: active.textModel,
    imageModel: routeProfile("image")?.imageModel || "",
    speechModel: routeProfile("speech")?.speechModel || "",
    voice: routeProfile("speech")?.voice || "",
    apiKeyConfigured: Boolean(active.apiKey),
    providers: visibleIds.map(id => aiConfig.profiles[id]).filter(Boolean).map(profile => safePublicProfile(profile, role === "owner")),
    routes: {
      text: aiConfig.routes.text,
      image: aiConfig.routes.image,
      speech: aiConfig.routes.speech,
      autoSelect: aiConfig.routes.autoSelect === true,
      autoImageSelect: aiConfig.routes.autoImageSelect === true,
      autoFallback: aiConfig.routes.autoFallback === true
    },
    imageRoutingReady: { image: imageRoutingProfiles(false).length > 0, imageEdit: imageRoutingProfiles(true).length > 0 },
    search: {
      provider: aiConfig.search.provider,
      providers: [
        { id: "auto", name: "Automat · recomandat", keyConfigured: Boolean(aiConfig.search.keys.brave || aiConfig.search.keys.tavily), requiresKey: false },
        { id: "bing", name: "Bing · fără cheie", keyConfigured: true, requiresKey: false },
        { id: "brave", name: "Brave Search", keyConfigured: Boolean(aiConfig.search.keys.brave), requiresKey: true },
        { id: "tavily", name: "Tavily", keyConfigured: Boolean(aiConfig.search.keys.tavily), requiresKey: true }
      ]
    }
  };
}

function availableOpenAiChatModels(catalog, fallback) {
  const values = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.data) ? catalog.data.map(item => item?.id) : [];
  const candidates = values
      .map(item => String(item || "").trim())
      .filter(id => /^gpt-\d+(?:\.\d+){0,2}(?:-(?:mini|nano))?$/i.test(id));
  if (!candidates.length) return fallback ? [fallback] : [];
  const tier = id => id.endsWith("-mini") ? 1 : id.endsWith("-nano") ? 0 : 2;
  const version = id => (id.match(/^gpt-(\d+(?:\.\d+){0,2})/i)?.[1] || "0").split(".").map(Number);
  return [...new Set(candidates)].sort((left, right) => {
    const a = version(left), b = version(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] || 0) - (a[index] || 0);
      if (difference) return difference;
    }
    return tier(right) - tier(left) || left.localeCompare(right);
  });
}

function recommendedChatModel(profile, models) {
  const available = Array.isArray(models) ? models : [];
  if (profile?.id === "gemini") {
    if (available.includes(profile.textModel)) return profile.textModel;
    return rankedGeminiChatModels(available)[0] || "";
  }
  const rankedGpt = availableOpenAiChatModels(available, "");
  if (rankedGpt.length) return rankedGpt[0];
  return available[0] || profile?.textModel || "";
}

function aiSettingsCipherKey() {
  const secret = process.env.NOVA_DATA_ENCRYPTION_KEY || ACCESS_PASSWORD || process.env.DATABASE_URL || localAiEncryptionSecret;
  if (!secret) throw new Error("Lipsește cheia pentru criptarea configurării AI persistente.");
  return crypto.createHash("sha256").update(secret).digest();
}

function storedAiSettings(settings = aiConfig) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aiSettingsCipherKey(), iv);
  const encryptedConfig = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  const encoded = encryptedConfig.toString("base64");
  const encodedIv = iv.toString("base64");
  const encodedTag = cipher.getAuthTag().toString("base64");
  return {
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    configCipher: encoded,
    configIv: encodedIv,
    configTag: encodedTag,
    // Kept as encrypted aliases so older backup checks never expect a plaintext credential.
    apiKeyCipher: encoded,
    apiKeyIv: encodedIv,
    apiKeyTag: encodedTag
  };
}

function decryptStoredValue(value, cipherField, ivField, tagField) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", aiSettingsCipherKey(), Buffer.from(value[ivField], "base64"));
  decipher.setAuthTag(Buffer.from(value[tagField], "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value[cipherField] || "", "base64")),
    decipher.final()
  ]).toString("utf8");
}

function cleanSearchKey(value) {
  return typeof value === "string" ? value.trim().slice(0, 4000) : "";
}

function normalizedAiConfig(value) {
  const next = {
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    profiles: Object.fromEntries(environmentProfiles.map(profile => [profile.id, { ...profile, capabilities: { ...profile.capabilities } }])),
    routes: { ...aiConfig.routes, fallbacks: [...(aiConfig.routes.fallbacks || [])] },
    search: { provider: aiConfig.search.provider, keys: { ...aiConfig.search.keys } }
  };
  const profiles = Array.isArray(value?.profiles) ? value.profiles : Object.values(value?.profiles || {});
  for (const candidate of profiles) {
    if (!candidate || typeof candidate !== "object") continue;
    const alias = { google: "gemini", claude: "anthropic", compatible: "custom" }[candidate.id] || candidate.id;
    const current = next.profiles[alias];
    if (!current) continue;
    try { next.profiles[alias] = sanitizeProfileUpdate({ ...candidate, id: alias }, current); }
    catch { /* Ignore a damaged profile and retain the environment configuration. */ }
  }
  const requestedText = String(value?.routes?.text || "");
  if (next.profiles[requestedText]?.capabilities?.text) next.routes.text = requestedText;
  for (const capability of ["image", "speech"]) {
    const requested = String(value?.routes?.[capability] || "");
    if (next.profiles[requested]?.capabilities?.[capability]) next.routes[capability] = requested;
  }
  next.routes.autoFallback = value?.routes?.autoFallback === true;
  next.routes.autoSelect = value?.routes?.autoSelect !== false;
  next.routes.autoImageSelect = typeof value?.routes?.autoImageSelect === "boolean"
    ? value.routes.autoImageSelect : process.env.AI_IMAGE_AUTO_SELECT !== "false" && next.routes.image === "openai";
  next.routes.fallbacks = [...new Set((Array.isArray(value?.routes?.fallbacks) ? value.routes.fallbacks : [])
    .map(id => String(id || "")).filter(id => next.profiles[id]?.capabilities?.text && id !== next.routes.text))];
  const searchProvider = String(value?.search?.provider || "").toLowerCase();
  if (["auto", "bing", "brave", "tavily"].includes(searchProvider)) next.search.provider = searchProvider;
  next.search.keys = {
    brave: cleanSearchKey(value?.search?.keys?.brave) || next.search.keys.brave,
    tavily: cleanSearchKey(value?.search?.keys?.tavily) || next.search.keys.tavily
  };
  return next;
}

function applyStoredAiSettings(value) {
  if (!value || typeof value !== "object") return;
  try {
    if (value.configCipher || (Number(value.schemaVersion) >= 3 && value.apiKeyCipher)) {
      const decrypted = decryptStoredValue(value, value.configCipher ? "configCipher" : "apiKeyCipher", value.configIv ? "configIv" : "apiKeyIv", value.configTag ? "configTag" : "apiKeyTag");
      const migrated = normalizedAiConfig(JSON.parse(decrypted));
      if (migrated.profiles.openai?.imageModel === "gpt-image-1") migrated.profiles.openai.imageModel = DEFAULT_IMAGE_MODEL;
      migrated.schemaVersion = AI_SETTINGS_SCHEMA_VERSION;
      aiConfig = migrated;
      return;
    }
    if (!["openai", "ollama"].includes(value.provider)) return;
    const apiKey = decryptStoredValue(value, "apiKeyCipher", "apiKeyIv", "apiKeyTag");
    const storedTextModel = String(value.textModel || DEFAULT_TEXT_MODEL);
    const textModel = Number(value.schemaVersion || 1) < 2 && storedTextModel === "gpt-4.1-mini"
      ? DEFAULT_TEXT_MODEL
      : storedTextModel;
    const storedImageModel = String(value.imageModel || DEFAULT_IMAGE_MODEL);
    const imageModel = Number(value.schemaVersion || 1) < AI_SETTINGS_SCHEMA_VERSION && ["gpt-image-1-mini", "gpt-image-1"].includes(storedImageModel)
      ? DEFAULT_IMAGE_MODEL
      : storedImageModel;
    const officialOpenAi = PLATFORM_PRESETS.openai.baseUrl.replace(/\/+$/, "");
    const baseUrl = String(value.baseUrl || officialOpenAi).replace(/\/+$/, "");
    const id = value.provider === "ollama" ? "ollama" : baseUrl === officialOpenAi ? "openai" : "custom";
    const migrated = cloneAiConfig();
    migrated.profiles[id] = sanitizeProfileUpdate({
      id, baseUrl, textModel, imageModel,
      speechModel: String(value.speechModel || PLATFORM_PRESETS.openai.speechModel),
      voice: String(value.voice || "nova"), apiKey: apiKey || migrated.profiles[id]?.apiKey || ""
    }, migrated.profiles[id]);
    migrated.routes.text = id;
    if (migrated.profiles[id].capabilities.image) migrated.routes.image = id;
    if (migrated.profiles[id].capabilities.speech) migrated.routes.speech = id;
    aiConfig = normalizedAiConfig(migrated);
  } catch (error) {
    console.error("Nova AI settings could not be decrypted; using environment configuration.");
  }
}

const AI_SETTINGS_FILE = path.join(DATA_DIR, "data", "ai-settings.json");
let localAiEncryptionSecret = "";

async function initializeAiEncryption() {
  if (dataStore.enabled || process.env.NOVA_DATA_ENCRYPTION_KEY || ACCESS_PASSWORD) return;
  const keyFile = path.join(DATA_DIR, "data", "ai-settings.key");
  await fs.promises.mkdir(path.dirname(keyFile), { recursive: true });
  try { await fs.promises.writeFile(keyFile, crypto.randomBytes(32).toString("hex"), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  localAiEncryptionSecret = (await fs.promises.readFile(keyFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(localAiEncryptionSecret)) throw new Error("Cheia locală pentru configurarea AI este invalidă.");
}

async function refreshAiSettings(force = false) {
  if (!force && Date.now() < aiSettingsCacheExpiresAt) return;
  const revision = aiSettingsRevision;
  let value;
  if (dataStore.enabled) value = await dataStore.getSetting("ai-provider");
  else {
    try { value = JSON.parse(await fs.promises.readFile(AI_SETTINGS_FILE, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") console.error("Nova AI settings file could not be read; keeping the current configuration.");
    }
  }
  if (revision !== aiSettingsRevision) return;
  if (value) applyStoredAiSettings(value);
  aiSettingsCacheExpiresAt = Date.now() + 1000;
}

async function persistAiSettings(settings = aiConfig) {
  const encrypted = storedAiSettings(settings);
  if (dataStore.enabled) await dataStore.setSetting("ai-provider", encrypted);
  else {
    await fs.promises.mkdir(path.dirname(AI_SETTINGS_FILE), { recursive: true });
    const temporary = `${AI_SETTINGS_FILE}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(encrypted), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.promises.rename(temporary, AI_SETTINGS_FILE);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  }
  aiSettingsRevision += 1;
  aiSettingsCacheExpiresAt = 0;
}

function configuredFallbackProfiles(primary) {
  if (!aiConfig.routes.autoFallback) return [];
  const explicit = aiConfig.routes.fallbacks || [];
  const automatic = Object.values(aiConfig.profiles)
    .filter(profile => profile.id !== "ollama" && profile.id !== primary.id && profile.capabilities.text && isProfileConfigured(profile))
    .map(profile => profile.id);
  return [...new Set([...explicit, ...automatic])]
    .map(id => aiConfig.profiles[id])
    .filter(profile => profile && profile.id !== primary.id && profile.capabilities.text && isProfileConfigured(profile));
}

async function cachedProfileModels(profile) {
  const signature = crypto.createHash("sha256").update(JSON.stringify([
    profile.id, profile.baseUrl, profile.textModel, profile.apiKey
  ])).digest("hex");
  const now = Date.now();
  if (aiHealthCache?.signature === signature && now - aiHealthCache.time < 30000) {
    if (aiHealthCache.error) throw Object.assign(new Error(aiHealthCache.error.message), { status: aiHealthCache.error.status });
    return [...aiHealthCache.models];
  }
  if (aiHealthPending?.signature === signature) return [...await aiHealthPending.promise];
  const promise = listProfileModels(profile, { timeout: 10000 })
    .then(models => {
      const normalized = [...models];
      aiHealthCache = { signature, time: Date.now(), models: normalized };
      return normalized;
    })
    .catch(error => {
      aiHealthCache = { signature, time: Date.now(), error: { status: Number(error.status) || 502, message: String(error.message || "Verificarea a eșuat.").slice(0, 500) } };
      throw error;
    })
    .finally(() => { if (aiHealthPending?.promise === promise) aiHealthPending = null; });
  aiHealthPending = { signature, promise };
  return [...await promise];
}

function rankedImageModels(models) {
  const candidates = [...new Set((Array.isArray(models) ? models : []).map(model => String(model || "").trim()).filter(model =>
    model && /(gpt-image|dall-?e|imagen|flux|stable[-_. ]?diffusion|image[-_. ]?(?:gen|generation))/i.test(model)
      && !/(embedding|moderation|vision|classifier)/i.test(model)
  ))];
  const score = model => {
    const value = model.toLowerCase();
    const family = value.includes("gpt-image") ? 5 : value.includes("imagen") ? 4 : value.includes("dall") ? 3 : value.includes("flux") ? 2 : 1;
    const numbers = [...value.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    return [family, ...numbers.slice(0, 3)];
  };
  return candidates.sort((left, right) => {
    const a = score(left), b = score(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] || 0) - (a[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  });
}

async function resolvedImageModel(profile) {
  // A catalog can omit valid generation models or include edit-only models.
  // The saved model and the generation endpoint are authoritative.
  if (profile.imageModel) return profile.imageModel;
  try {
    const catalog = await cachedProfileModels(profile);
    const available = rankedImageModels(catalog);
    if (available.includes(profile.imageModel)) return profile.imageModel;
    if (available.length) return available[0];
  } catch (error) {
    // Some compatible APIs do not implement /models; their configured media
    // model is still allowed and the generation endpoint remains authoritative.
  }
  return profile.imageModel;
}

function imageGenerationOptions(model) {
  if (/dall-?e-?3/i.test(model)) return { size: "1024x1024", quality: "hd", n: 1, response_format: "b64_json" };
  if (/dall-?e-?2/i.test(model)) return { size: "1024x1024", n: 1, response_format: "b64_json" };
  if (/gpt-image/i.test(model)) return { size: "1024x1024", quality: "high", n: 1 };
  return { size: "1024x1024", n: 1 };
}

function missingImageModel(error) {
  return /(model).*(does not exist|not found|unknown|invalid)|(does not exist|not found|unknown model)/i.test(String(error?.message || ""));
}

function openAiImageCandidates(profile, preferred, { editing = false } = {}) {
  if (["gemini", "openrouter"].includes(profile.id) || profile.id !== "openai" && !/^gpt-image-/i.test(preferred || "")) return [preferred];
  const fallbacks = editing ? ["gpt-image-1.5", "gpt-image-1"] : ["gpt-image-1.5", "gpt-image-1", "dall-e-3"];
  return [...new Set([preferred, ...fallbacks].filter(Boolean))];
}

function imageRequestBudget(profile, options = {}) {
  const timeout = options.timeout || 300000;
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const started = Date.now();
  return {
    signal,
    remaining() {
      options.signal?.throwIfAborted();
      const remaining = timeout - (Date.now() - started);
      if (deadline.aborted || remaining <= 0) throw Object.assign(new Error("Generarea imaginii a depășit timpul disponibil."), {
        status: 504, provider: profile.id, failureKind: "timeout"
      });
      return remaining;
    }
  };
}

async function generateWithAvailableImageModel(profile, prompt, preferred, options = {}) {
  const budget = imageRequestBudget(profile, options);
  let lastError;
  for (const model of openAiImageCandidates(profile, preferred)) {
    try {
      const result = ["gemini", "openrouter"].includes(profile.id)
        ? await generateProfileImage(profile, prompt, { model, timeout: budget.remaining(), signal: budget.signal })
        : await openAiCompatibleJson(profile, "/images/generations", {
          method: "POST", json: { model, prompt, ...imageGenerationOptions(model) },
          timeout: budget.remaining(), signal: budget.signal
        });
      budget.remaining();
      return { result, model };
    } catch (error) {
      budget.remaining();
      lastError = error;
      if (!missingImageModel(error)) throw error;
    }
  }
  throw lastError;
}

async function editWithAvailableImageModel(profile, source, prompt, preferred, options = {}) {
  const budget = imageRequestBudget(profile, options);
  let lastError;
  for (const model of openAiImageCandidates(profile, preferred, { editing: true })) {
    try {
      const result = ["gemini", "openrouter"].includes(profile.id)
        ? await generateProfileImage(profile, prompt, { model, image: source, timeout: budget.remaining(), signal: budget.signal })
        : await openAiCompatibleImageEdit(profile, source, prompt, { model, timeout: budget.remaining(), signal: budget.signal });
      budget.remaining();
      return { result, model };
    } catch (error) {
      budget.remaining();
      lastError = error;
      if (!missingImageModel(error)) throw error;
    }
  }
  throw lastError;
}

function imageRoutingProfiles(editing = false) {
  const selected = aiConfig.profiles[aiConfig.routes.image];
  const automatic = aiConfig.routes.autoImageSelect === true;
  return [selected, ...(automatic ? Object.values(aiConfig.profiles) : [])]
    .filter((profile, index, profiles) => profile && profiles.findIndex(item => item?.id === profile.id) === index)
    .filter(profile => profile.baseUrl && profile.capabilities?.image && (!editing || profile.capabilities.imageEdit)
      && (profile.apiKey || profile.id === selected?.id && !profile.requiresKey && localProviderUrl(profile))
      && (automatic || profile.imageModel));
}

async function routedImage(prompt, source, candidates, signal) {
  const budget = imageRequestBudget(candidates[0], { signal });
  const automatic = aiConfig.routes.autoImageSelect === true;
  const failures = [];
  let lastError;
  for (let index = 0; index < candidates.length; index++) {
    const profile = candidates[index];
    const remaining = () => {
      try { return budget.remaining(); }
      catch (error) { error.provider = profile.id; throw error; }
    };
    // Leave time for later providers instead of giving a stalled first provider
    // the entire operation deadline.
    const attempt = automatic ? imageRequestBudget(profile, {
      signal: budget.signal, timeout: Math.max(1, Math.floor(remaining() / (candidates.length - index)))
    }) : budget;
    try {
      let model = profile.imageModel;
      if (!model) {
        const models = await listProfileImageModels(profile, {
          timeout: Math.min(10000, attempt.remaining()), signal: attempt.signal, imageEdit: Boolean(source)
        });
        model = models.find(value => !/(preview|experimental|exp-)/i.test(value)) || models[0];
        if (!model) throw Object.assign(new Error(`Nu există modele de imagini disponibile la ${profile.name}.`), { status: 503 });
      }
      const options = { signal: attempt.signal, timeout: attempt.remaining() };
      const generated = source
        ? await editWithAvailableImageModel(profile, source, prompt, model, options)
        : await generateWithAvailableImageModel(profile, prompt, model, options);
      const image = generated.result?.data?.[0];
      if (!image?.b64_json && !image?.url) throw Object.assign(new Error("Serviciul nu a returnat o imagine."), { status: 502, failureKind: "invalid_response" });
      const output = providerImageDataUrl(image);
      attempt.remaining();
      remaining();
      return { ...output, model: generated.model, provider: profile.id, providerName: profile.name, ...(source ? { edited: true } : {}) };
    } catch (error) {
      remaining();
      if (attempt.signal.aborted) error = Object.assign(new Error("Motorul de imagini nu a răspuns în timpul disponibil."), {
        status: 504, failureKind: "timeout", provider: profile.id
      });
      error.provider ||= profile.id;
      lastError = error;
      failures.push({ provider: profile.id, name: profile.name, status: Number(error.status) || 502 });
      // Authentication, invalid prompts and content-policy refusals need a direct
      // correction; automatic recovery is limited to quota and availability.
      const retryable = [402, 404, 408, 429].includes(Number(error.status))
        || Number(error.status) >= 500 && Number(error.status) <= 599;
      if (!automatic || !retryable) throw error;
    }
  }
  if (lastError) { lastError.imageFailures = failures; throw lastError; }
  throw Object.assign(new Error("Nu există un motor de imagini configurat."), { status: 503 });
}

function friendlyImageProviderError(error, profile, model) {
  const message = String(error?.message || "");
  if (error.imageFailures?.length > 1) {
    const detail = error.imageFailures.map(item => `${item.name}: ${[402, 429].includes(item.status) ? "cotă API" : item.status === 504 ? "timp expirat" : `HTTP ${item.status}`}`).join("; ");
    return `Niciun motor de imagini încercat nu a putut răspunde. ${detail}.`;
  }

  if ([401, 403].includes(Number(error?.status))) return `${profile.name} a respins cheia sau accesul la modelul de imagini. Verifică profilul din Motoare AI.`;
  if ([402, 429].includes(Number(error?.status))) return `${profile.name} nu are credit sau cotă API disponibilă pentru imagini. Verifică facturarea furnizorului sau alege altă rută de imagini.`;
  if (Number(error?.status) === 504) return `Generarea imaginii la ${profile.name} a depășit timpul disponibil. Încearcă din nou.`;

  if (missingImageModel(error)) {
    return `Modelul de imagine „${model}” nu este disponibil la ${profile.name}. Deschide Motoare AI și alege o rută de imagini oferită de furnizor.`;
  }
  return message || "Generarea imaginii a eșuat.";
}

function friendlyTextProviderError(error, profile, model) {
  const status = Number(error?.status) || 502;
  const name = profile?.name || "Furnizorul AI";
  const selectedModel = String(model || profile?.textModel || "modelul selectat");
  const message = String(error?.message || "");
  if (status === 401 || status === 403) return `${name} a respins cheia API sau accesul proiectului. Creează o cheie validă, salveaz-o în Motoare AI și verifică permisiunile contului.`;
  if (status === 402) return `${name} a refuzat cererea pentru facturarea API (cod 402). Verifică soldul și facturarea contului furnizorului.`;
  if (status === 429) {
    if (error.quotaFallbackExhausted) return "Motoarele AI încercate au refuzat cererea din cauza cotelor lor API. Aceasta nu este o limită de creare Nova. Verifică creditul sau limitele furnizorilor ori configurează un alt motor disponibil.";
    if (error.code === "insufficient_quota") return `${name} nu mai are credit sau cotă API disponibilă. Aceasta nu este o limită de creare Nova. Verifică facturarea API sau activează modul automat cu un alt motor configurat.`;
    return `${name} a atins limita de cereri sau cota API. Aceasta nu este o limită de creare Nova. Activează modul automat cu un alt motor configurat sau verifică limitele API ale furnizorului.`;
  }
  if (status === 404 || /model.*(?:not found|does not exist|unknown|invalid)/i.test(message)) return `Modelul „${selectedModel}” nu este disponibil la ${name}. Reîncarcă modelele și alege unul din catalogul furnizorului.`;
  if (status === 400 && /(tool|function|function.?call)/i.test(message)) return `Modelul „${selectedModel}” de la ${name} nu acceptă uneltele necesare acestei cereri. Alege un model cu function calling sau alt furnizor text.`;
  if (status === 400) return `${name} a respins cererea pentru modelul „${selectedModel}”. Reîncarcă modelele și încearcă un model compatibil.`;
  if ([408, 504].includes(status)) return `Conexiunea cu ${name} a expirat. Încearcă din nou; dacă problema continuă, activează un motor de rezervă.`;
  if (error.failureKind === "network") {
    if (["ENOTFOUND", "EAI_AGAIN"].includes(error.code)) return `Serverul Nova nu poate rezolva adresa API pentru ${name} (eroare DNS). Verifică rețeaua și adresa API de pe serverul de găzduire.`;
    if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(error.code)) return `Serverul Nova nu poate verifica certificatul conexiunii securizate către ${name} (eroare TLS). Verifică certificatele de pe serverul de găzduire.`;
    return `Serverul Nova nu poate contacta API-ul ${name} (eroare de conexiune). Verifică accesul la rețea de pe serverul de găzduire.`;
  }
  if (error.failureKind === "invalid_response") return `API-ul ${name} a returnat un răspuns invalid sau incompatibil. Verifică modelul și protocolul API; răspunsul nu confirmă o indisponibilitate a furnizorului.`;
  if (error.failureKind === "http" && status >= 500) return `${name} a returnat HTTP ${status}. Serviciul furnizorului a respins cererea cu o eroare de server. Încearcă din nou sau activează un motor de rezervă în Motoare AI.`;
  if (error.failureKind === "provider_error") return `${name} a raportat o eroare de procesare (cod ${status}) în răspunsul API. Încearcă din nou sau verifică motorul în Motoare AI.`;
  if (status >= 500) return `Nova nu a putut obține un răspuns valid de la ${name} (cod ${status}). Încearcă testul de chat din Administrare pentru a verifica motorul configurat.`;
  return `${name} nu a putut procesa cererea cu modelul „${selectedModel}”.`;
}

function requireRouteProfile(capability) {
  const profile = routeProfile(capability);
  if (!profile?.capabilities?.[capability]) throw Object.assign(new Error(`Nu este configurat un motor pentru ${capability === "image" ? "imagini" : capability === "speech" ? "voce" : "text"}.`), { status: 503 });
  if (!routeProfileConfigured(profile, capability)) throw Object.assign(new Error(`Motorul ${profile.name} nu este configurat complet pentru ${capability === "image" ? "imagini" : capability === "speech" ? "voce" : "text"}.`), { status: 503 });
  return profile;
}

function providerImageDataUrl(image) {
  const rawFormat = String(image?.output_format || "png").trim().toLowerCase();
  const format = rawFormat === "jpg" ? "jpeg" : rawFormat;
  if (!["png", "jpeg", "webp"].includes(format)) throw Object.assign(new Error("Serviciul a returnat un format de imagine neacceptat."), { status: 502 });
  if (image?.b64_json) {
    const base64 = String(image.b64_json);
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(base64) || base64.length > 32 * 1024 * 1024) {
      throw Object.assign(new Error("Serviciul a returnat date de imagine invalide."), { status: 502 });
    }
    return { dataUrl: `data:image/${format};base64,${base64}`, format: format === "jpeg" ? "jpg" : format };
  }
  let remote;
  try { remote = new URL(String(image?.url || "")); }
  catch { throw Object.assign(new Error("Serviciul a returnat o adresă de imagine invalidă."), { status: 502 }); }
  if (remote.protocol !== "https:" || remote.username || remote.password) {
    throw Object.assign(new Error("Serviciul trebuie să returneze imaginea prin HTTPS."), { status: 502 });
  }
  return { dataUrl: remote.href, format: format === "jpeg" ? "jpg" : format };
}

function searchConfiguration() {
  return { provider: aiConfig.search.provider, keys: { ...aiConfig.search.keys } };
}

function uploadedImage(value) {
  if (typeof value !== "string" || value.length > MAX_IMAGE_EDIT_BODY) throw Object.assign(new Error("Imaginea încărcată este prea mare."), { status: 413 });
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error("Încarcă o imagine PNG, JPG sau WebP validă."), { status: 400 });
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_UPLOAD) throw Object.assign(new Error("Imaginea poate avea cel mult 8 MiB."), { status: 413 });
  const mime = match[1];
  const validSignature = mime === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validSignature) throw Object.assign(new Error("Conținutul fișierului nu corespunde formatului imaginii."), { status: 400 });
  return { bytes, mime, extension: mime === "image/jpeg" ? "jpg" : mime.slice(6) };
}

function missingTextModel(error) {
  return Number(error?.status) === 404 || /model.*(?:not found|does not exist|unknown|invalid|unavailable)|(?:not found|does not exist|unknown).*model/i.test(String(error?.message || ""));
}

function rankedGeminiChatModels(models) {
  const candidates = [...new Set((Array.isArray(models) ? models : [])
    .map(model => String(model || "").trim().replace(/^models\/+/, ""))
    .filter(model => /^gemini-/i.test(model) && !/(embedding|imagen|image|tts|audio|live|robotics|aqa)/i.test(model)))];
  const score = model => {
    const value = model.toLowerCase();
    const stable = /(preview|experimental|exp(?:-|$))/.test(value) ? 0 : 1;
    const accessible = value.includes("flash") ? 2 : value.includes("pro") ? 1 : 0;
    const versions = [...value.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    return [stable, accessible, ...versions.slice(0, 2)];
  };
  return candidates.sort((left, right) => {
    const a = score(left), b = score(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] || 0) - (a[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  });
}

function geminiOverloaded(error) {
  return error?.failureKind === "http" && Number(error.status) === 503 && Number(error.upstreamStatus) === 503;
}

async function recoverGeminiOverload(profile, preferredModel, options, firstError, startedAt) {
  const timeout = options.timeout || 180000;
  const remaining = () => Math.max(0, timeout - (Date.now() - startedAt));
  options.signal?.throwIfAborted();
  if (!remaining()) throw firstError;
  const deadline = AbortSignal.timeout(remaining());
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const checkActive = () => {
    options.signal?.throwIfAborted();
    if (deadline.aborted || !remaining()) throw Object.assign(new Error("Conexiunea cu furnizorul AI a expirat."), {
      provider: profile.id, status: 504, failureKind: "timeout"
    });
  };
  const pause = async (error, minimum) => {
    checkActive();
    const milliseconds = Math.max(minimum, error.retryAfterMs || 0);
    // Do not retry earlier than Retry-After when its delay exceeds our budget.
    if (!Number.isFinite(milliseconds) || milliseconds >= remaining()) throw error;
    if (milliseconds) await delay(milliseconds, undefined, { signal });
    checkActive();
  };
  const send = async model => {
    checkActive();
    return chatWithProfile(profile, { ...options, model, signal, timeout: Math.max(1, remaining()) });
  };
  let lastError = firstError;
  try {
    await pause(firstError, 1000);
    try { return await send(preferredModel); }
    catch (error) {
      checkActive();
      if (!geminiOverloaded(error)) throw error;
      lastError = error;
    }
    // Stay within the configured Flash family and use only the live catalog.
    if (!/-flash(?:-|$)/i.test(preferredModel)) throw lastError;
    await pause(lastError, 0);
    let catalog;
    try { catalog = await listProfileModels(profile, { signal, timeout: Math.max(1, Math.min(10000, remaining())) }); }
    catch (error) {
      checkActive();
      if ([400, 401, 403, 429].includes(Number(error.status))) throw error;
      throw lastError;
    }
    const alternatives = rankedGeminiChatModels(catalog).filter(model => model !== preferredModel
      && /-flash(?:-|$)/i.test(model) && !/(preview|experimental|(?:^|-)exp(?:-|$)|(?:^|-)pro(?:-|$))/i.test(model)).slice(0, 2);
    for (let index = 0; index < alternatives.length; index++) {
      if (index) await pause(lastError, 0);
      try { return await send(alternatives[index]); }
      catch (error) {
        checkActive();
        if (geminiOverloaded(error)) lastError = error;
        else if (Number(error.status) !== 404) throw error;
      }
    }
    throw lastError;
  } catch (error) {
    checkActive();
    throw error;
  }
}

async function chatWithResolvedTextModel(profile, preferredModel, options) {
  if (profile.id === "gemini") preferredModel = String(preferredModel || profile.textModel || "").trim().replace(/^models\/+/, "");
  const startedAt = Date.now();
  try { return await chatWithProfile(profile, { ...options, model: preferredModel }); }
  catch (firstError) {
    const errorDetails = firstError.details?.error?.details;
    const violations = (Array.isArray(errorDetails) ? errorDetails : []).flatMap(detail =>
      detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' && Array.isArray(detail.violations) ? detail.violations : []) || [];
    const fixedQuota = violations.some(violation => String(violation.quotaValue) === '0' || /perday|permonth/i.test(violation.quotaId || ''));
    const retryWait = firstError.retryAfterMs;
    if (profile.id === "gemini" && Number(firstError.status) === 429 && !fixedQuota
      && Number.isFinite(retryWait) && retryWait > 0 && retryWait <= 30000
      && Date.now() - startedAt + retryWait < (options.timeout || 180000)) {
      options.signal?.throwIfAborted();
      await delay(retryWait, undefined, { signal: options.signal });
      options.signal?.throwIfAborted();
      return chatWithProfile(profile, { ...options, model: preferredModel,
        timeout: Math.max(1, (options.timeout || 180000) - (Date.now() - startedAt)) });
    }
    if (profile.id === "gemini" && geminiOverloaded(firstError)) {
      return recoverGeminiOverload(profile, preferredModel, options, firstError, startedAt);
    }
    if (profile.id !== "gemini" || !missingTextModel(firstError)) throw firstError;
    let catalog = [];
    try { catalog = await listProfileModels(profile, { timeout: 10000, signal: options.signal, fallback: false }); }
    catch { options.signal?.throwIfAborted(); throw firstError; }
    let lastError = firstError;
    for (const candidate of rankedGeminiChatModels(catalog).filter(candidate => candidate !== preferredModel).slice(0, 6)) {
      try {
        const result = await chatWithProfile(profile, { ...options, model: candidate });
        profile.textModel = candidate;
        aiHealthCache = null;
        try { await persistAiSettings(aiConfig); }
        catch (error) { console.error("Nova AI could not persist the resolved Gemini model:", { status: error.status || 500 }); }
        return result;
      } catch (error) {
        lastError = error;
        if (!missingTextModel(error)) throw error;
      }
    }
    throw lastError;
  }
}

async function providerChat(model, messages, tools, maxOutputTokens = null, verifyWeb = false, signal, routing = {}) {
  signal?.throwIfAborted();
  if (!routing.selection) {
    const automatic = aiConfig.routes.autoSelect === true ? automaticTextProfiles() : [];
    const primary = automatic[0] || requireRouteProfile("text");
    const start = automatic.length ? automaticProviderCursor++ % automatic.length : 0;
    const initial = automatic[start] || primary;
    routing.selection = { automatic, primary, initial, explicitFallback: configuredFallbackProfiles(initial).slice(0, 1) };
  }
  const { automatic, primary, initial, explicitFallback } = routing.selection;
  // One user action can require several tool rounds. Rotate only between user
  // actions; keep each tool continuation with the provider and model that issued it.
  const chosen = routing.active?.profile || initial;
  const start = Math.max(0, automatic.findIndex(profile => profile.id === chosen.id));
  const quotaAlternatives = [...automatic.slice(start + 1), ...automatic.slice(0, start)];
  const candidates = [chosen];
  const attempted = new Set();
  const quotaRejected = new Set();
  let lastError;
  for (let index = 0; index < candidates.length; index++) {
    const profile = candidates[index];
    attempted.add(profile.id);
    try {
      const requestedModel = routing.active?.profile.id === profile.id ? routing.active.model
        : profile.id === primary.id ? model : profile.textModel;
      if (routing.active && routing.active.profile.id !== profile.id) {
        routing.foreignToolIds ||= new Set();
        for (const message of messages) {
          for (const call of message.role === "assistant" ? message.tool_calls || [] : []) routing.foreignToolIds.add(call.id);
        }
      }
      let providerMessages = messages;
      if (routing.foreignToolIds?.size) {
        const resultIds = new Set(messages.filter(message => message.role === "tool").map(message => message.tool_call_id));
        // Opaque tool signatures belong to the issuing provider. Preserve completed
        // work as an explicit transcript when failing over, without inventing signatures
        // or replaying writes. Future calls from the new provider stay structured.
        providerMessages = messages.map(message => {
          const calls = message.role === "assistant" ? message.tool_calls || [] : [];
          if (calls.some(call => routing.foreignToolIds.has(call.id))) {
            const transcript = calls.map(call => ({
              id: call.id, name: call.function?.name, arguments: call.function?.arguments,
              status: resultIds.has(call.id) ? "rezultat disponibil în mesajele următoare" : "rezultat lipsă; execuția nu este confirmată"
            }));
            return { role: "assistant", content: `${message.content || ""}\nUnelte cerute anterior de alt motor (istoric, fără reexecutare automată):\n${JSON.stringify(transcript)}` };
          }
          if (message.role === "tool" && routing.foreignToolIds.has(message.tool_call_id)) {
            return { role: "assistant", content: `Rezultat unealtă anterioară (${message.tool_call_id}):\n${message.content || ""}` };
          }
          return message;
        });
      }
      const result = await chatWithResolvedTextModel(profile, requestedModel, {
        messages: providerMessages,
        tools,
        maxOutputTokens,
        signal,
        forceWebTool: verifyWeb && tools?.some(tool => tool.function?.name === "web_search")
      });
      if (String(result.message?.content || "").trim() || result.message?.tool_calls?.length) providerStatus.success(profile, result);
      else providerStatus.failure(profile, { status: 502, failureKind: "invalid_response" }, friendlyTextProviderError({ status: 502, failureKind: "invalid_response" }, profile, profile.textModel));
      routing.active = { profile, model: result.model || requestedModel };
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      providerStatus.failure(profile, error, friendlyTextProviderError(error, profile, profile.textModel));
      lastError = error;
      if (!isTransientProviderError(error)) throw error;
      const quotaLimited = Number(error.status) === 429;
      if (quotaLimited) quotaRejected.add(profile.id);
      // Automatic mode already authorizes this configured pool. A gateway
      // failure or timed-out connection must not strand an otherwise usable pool.
      const serviceUnavailable = error.failureKind === "timeout"
        || error.failureKind === "network"
        || ["http", "provider_error"].includes(error.failureKind)
          && [502, 503, 504].includes(Number(error.status));
      const alternatives = quotaLimited || serviceUnavailable ? [...quotaAlternatives, ...explicitFallback] : explicitFallback;
      const next = alternatives.find(candidate => !attempted.has(candidate.id));
      if (!next) {
        if (quotaLimited && quotaRejected.size > 1) error.quotaFallbackExhausted = true;
        throw error;
      }
      candidates.push(next);
    }
  }
  throw lastError || new Error("Niciun motor AI nu este disponibil.");
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

function cvField(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n").slice(0, maximum) : "";
}

function escapeCvHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function cvList(value, { commas = false } = {}) {
  const pattern = commas ? /[,\n]/ : /\n/;
  return value.split(pattern).map(item => item.trim().replace(/^[-•]\s*/, "")).filter(Boolean);
}

function cvSection(title, items, className = "timeline") {
  if (!items.length) return "";
  return `<section><h2>${escapeCvHtml(title)}</h2><ul class="${className}">${items.map(item => `<li>${escapeCvHtml(item)}</li>`).join("")}</ul></section>`;
}

function cvLinkHtml(item) {
  const match = item.match(/https:\/\/[^\s<>"']+/i);
  if (!match) return `<li>${escapeCvHtml(item)}</li>`;
  try {
    const parsed = new URL(match[0]);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
    return `<li><a href="${escapeCvHtml(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeCvHtml(item)}</a></li>`;
  } catch { return `<li>${escapeCvHtml(item)}</li>`; }
}

function buildCvFiles(input) {
  input = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const value = {
    name: cvField(input.name, 80),
    role: cvField(input.role, 100),
    email: cvField(input.email, 160),
    phone: cvField(input.phone, 60),
    location: cvField(input.location, 120),
    summary: cvField(input.summary, 1600),
    experience: cvField(input.experience, 5000),
    education: cvField(input.education, 3000),
    skills: cvField(input.skills, 1600),
    links: cvField(input.links, 1600)
  };
  if (!value.name || !value.role) throw Object.assign(new Error("Completează numele și titlul profesional."), { status: 400 });
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw Object.assign(new Error("Adresa de e-mail nu este validă."), { status: 400 });
  const contact = [value.email, value.phone, value.location].filter(Boolean).map(item => `<li>${escapeCvHtml(item)}</li>`)
    .concat(cvList(value.links).map(cvLinkHtml));
  const summary = value.summary ? `<section class="profile"><h2>Profil</h2><p>${escapeCvHtml(value.summary).replaceAll("\n", "<br>")}</p></section>` : "";
  const html = `<!doctype html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="description" content="CV profesional — ${escapeCvHtml(value.name)}">
  <title>${escapeCvHtml(value.name)} · CV</title>
  <link rel="stylesheet" href="styles.css">
  <script src="app.js" defer></script>
</head>
<body>
  <div class="cv-actions" aria-label="Acțiuni CV"><button id="printCv" type="button">Descarcă PDF / Tipărește</button><button id="shareCv" type="button">Trimite CV-ul</button><span id="shareStatus" role="status"></span></div>
  <main class="cv">
    <header><p class="eyebrow">Curriculum Vitae</p><h1>${escapeCvHtml(value.name)}</h1><p class="role">${escapeCvHtml(value.role)}</p>${contact.length ? `<ul class="contact">${contact.join("")}</ul>` : ""}</header>
    ${summary}
    ${cvSection("Experiență", cvList(value.experience))}
    ${cvSection("Educație", cvList(value.education))}
    ${cvSection("Competențe", cvList(value.skills, { commas: true }), "skills")}
  </main>
</body>
</html>
`;
  const css = `:root{color-scheme:light;--ink:#17212b;--muted:#596773;--accent:#176b68;--paper:#fff;--line:#d9e3e6;font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3f4;color:var(--ink)}.cv{width:min(900px,100%);margin:0 auto;padding:64px;background:var(--paper);box-shadow:0 20px 70px #18363b20}.eyebrow{margin:0 0 10px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:clamp(38px,7vw,68px);line-height:1;letter-spacing:-.045em}.role{margin:14px 0 22px;color:var(--muted);font-size:21px}.contact{display:flex;flex-wrap:wrap;gap:8px 20px;margin:0;padding:18px 0 0;border-top:1px solid var(--line);list-style:none;color:var(--muted);font-size:14px}.contact a{color:var(--accent);overflow-wrap:anywhere}section{display:grid;grid-template-columns:180px 1fr;gap:32px;margin-top:42px;padding-top:30px;border-top:1px solid var(--line)}h2{margin:0;color:var(--accent);font-size:15px;letter-spacing:.08em;text-transform:uppercase}.profile p{margin:0;white-space:normal}.timeline{display:grid;gap:16px;margin:0;padding:0;list-style:none}.timeline li{position:relative;padding-left:20px}.timeline li::before{content:"";position:absolute;left:0;top:.65em;width:7px;height:7px;border-radius:50%;background:var(--accent)}.skills{display:flex;flex-wrap:wrap;gap:9px;margin:0;padding:0;list-style:none}.skills li{padding:7px 11px;border:1px solid var(--line);border-radius:999px;background:#f7faf9;font-size:14px}.cv-actions{position:sticky;top:12px;z-index:2;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:10px;width:min(900px,100%);margin:0 auto 18px}.cv-actions button{padding:11px 16px;border:0;border-radius:9px;background:#176b68;color:#fff;font:inherit;font-weight:750;cursor:pointer}.cv-actions button+button{background:#253746}.cv-actions span{width:100%;color:#36545b;text-align:center;font-size:13px}@media(max-width:700px){body{padding:0}.cv{padding:34px 24px;box-shadow:none}section{grid-template-columns:1fr;gap:14px;margin-top:30px}.cv-actions{position:static;margin:0;padding:12px;background:#e4edef}}@media print{body{padding:0;background:#fff}.cv{width:100%;padding:12mm;box-shadow:none}.cv-actions{display:none}section{break-inside:avoid}a{color:inherit;text-decoration:none}}`;
  const script = `"use strict";\ndocument.getElementById("printCv").addEventListener("click",()=>window.print());\ndocument.getElementById("shareCv").addEventListener("click",async()=>{const status=document.getElementById("shareStatus"),data={title:document.title,text:"CV profesional",url:location.href};try{if(navigator.share)await navigator.share(data);else{await navigator.clipboard.writeText(location.href);status.textContent="Linkul CV-ului a fost copiat.";}}catch(error){if(error.name!=="AbortError")status.textContent="Copiază linkul din bara browserului.";}});\n`;
  return { projectName: `CV ${value.name}`.slice(0, 80), files: { "index.html": html, "styles.css": css, "app.js": script } };
}

async function createProjectWorkspace(originalName, principal, { empty = false, subscriber = false, metadata = {} } = {}) {
  const name = typeof originalName === "string" ? originalName.trim() : "";
  if (!name || name.length > 80) throw Object.assign(new Error("Numele proiectului trebuie să aibă între 1 și 80 de caractere."), { status: 400 });
  if (subscriber) {
    const currentProjects = await dataFs.promises.readdir(workspacePaths(principal).projects).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (currentProjects.length >= 10) throw Object.assign(new Error("Un cont de abonat poate avea cel mult 10 proiecte."), { status: 403 });
  }
  const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "proiect";
  let id = slug;
  const paths = workspacePaths(principal);
  await dataFs.promises.mkdir(paths.trash, { recursive: true });
  while (await pathExists(path.join(paths.projects, id)) || (await dataFs.promises.readdir(paths.trash)).some(item => item.startsWith(`${id}.`))) id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const root = projectRoot(id, principal);
  await dataFs.promises.mkdir(path.join(root, "src"), { recursive: true });
  await dataFs.promises.writeFile(path.join(root, ".nova-project.json"), JSON.stringify({ name, ...metadata }, null, 2), "utf8");
  if (!empty) {
    await dataFs.promises.writeFile(path.join(root, "README.md"), `# ${name}\n\nProiect creat în Nova AI Studio.\n`, "utf8");
    await dataFs.promises.writeFile(path.join(root, "src", "index.js"), `// Începe să construiești ${name}.\n\nfunction main() {\n  console.log("Salut, Nova!");\n}\n\nmain();\n`, "utf8");
    await dataFs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ name: id, version: "0.1.0", private: true }, null, 2) + "\n", "utf8");
  }
  return { id, name };
}

async function projectForCvRequest(principal, requestId) {
  const projectsDir = workspacePaths(principal).projects;
  const entries = await dataFs.promises.readdir(projectsDir, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
    try {
      const metadata = JSON.parse(await dataFs.promises.readFile(path.join(projectsDir, entry.name, ".nova-project.json"), "utf8"));
      if (metadata.cvRequestId === requestId) return { id: entry.name, name: metadata.name || entry.name };
    } catch {}
  }
  return null;
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

async function readPublications() {
  try {
    const value = JSON.parse(await dataFs.promises.readFile(PUBLICATIONS_FILE, "utf8"));
    return value?.version === 1 && value.sites && typeof value.sites === "object" ? value : { version: 1, sites: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, sites: {} };
    throw error;
  }
}

async function withPublicationLock(operation) {
  const previous = publicationQueue;
  let release;
  publicationQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await dataStore.withLock(operation); }
  finally { release(); }
}

async function writePublications(value) {
  await dataFs.promises.mkdir(path.dirname(PUBLICATIONS_FILE), { recursive: true });
  await dataFs.promises.writeFile(PUBLICATIONS_FILE, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

async function publicationFor(principal, project) {
  const publications = await readPublications();
  const pair = Object.entries(publications.sites).find(([, site]) => site.principal === principal && site.project === project);
  return pair ? { id: pair[0], ...pair[1] } : null;
}

async function assertPrincipalActive(principal) {
  if (principal === "owner") return;
  const record = (await readAccounts()).users.find(user => user.id === principal);
  if (!record) throw Object.assign(new Error("Contul nu mai este disponibil."), { status: 401 });
  if (record.deleting) throw Object.assign(new Error("Ștergerea contului este în curs."), { status: 423 });
}

const restaurants = createRestaurantService({ filesystem: () => dataFs, root: DATA_DIR, withLock: withPublicationLock, assertPrincipalActive });
const restaurantRates = new Map();
function restaurantRate(req, group, maximum) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim().slice(0, 100);
  const key = group + ":" + ip, now = Date.now();
  if (restaurantRates.size > 5000) for (const [key, value] of restaurantRates) if (value.until <= now) restaurantRates.delete(key);
  if (restaurantRates.size > 5000) throw Object.assign(new Error("Serviciul este ocupat. Încearcă mai târziu."), { status: 429 });
  const previous = restaurantRates.get(key);
  const value = previous && previous.until > now ? previous : { count: 0, until: now + 60000 };
  if (++value.count > maximum) throw Object.assign(new Error("Prea multe cereri. Încearcă din nou peste un minut."), { status: 429 });
  restaurantRates.set(key, value);
}
async function restaurantResponse(res, operation, status = 200) {
  try { return json(res, status, await operation()); }
  catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 503 ? error.status : 500;
    return json(res, status, { error: status === 500 ? "Serviciul restaurantelor nu este disponibil. Încearcă din nou." : error.message });
  }
}
async function installRestaurantProject(principal, project) {
  const contents = {};
  for (const [target, source] of [["app.js", "restaurants-app.js"], ["styles.css", "restaurants.css"], ["index.html", "restaurants.html"]]) {
    contents[target] = (await fs.promises.readFile(path.join(PUBLIC_DIR, source), "utf8")).replaceAll('/restaurants.css', './styles.css').replaceAll('/restaurants-app.js', './app.js');
  }
  for (const [name, content] of Object.entries(contents)) await writeProjectFile(project, name, content, principal);
  return contents;
}
async function markRestaurantProject(principal, project) {
  const file = path.join(projectRoot(project, principal), ".nova-project.json");
  const metadata = JSON.parse(await dataFs.promises.readFile(file, "utf8"));
  metadata.nativeBusinessType = "restaurant-marketplace-v1";
  await dataFs.promises.writeFile(file, JSON.stringify(metadata), "utf8");
}
async function upgradeReportedRestaurantSite() {
  // One-time, scoped repair of the publication explicitly reported by its owner.
  // Existing writeProjectFile backups preserve the old files; do not migrate unrelated sites.
  const id = "e90b8660cff0e648a383bda3";
  const site = (await readPublications()).sites[id];
  if (!site) return;
  const metadataPath = path.join(projectRoot(site.project, site.principal), ".nova-project.json");
  const metadata = JSON.parse(await dataFs.promises.readFile(metadataPath, "utf8"));
  if (metadata.nativeBusinessType) return;
  const html = await readProjectFile(site.project, "index.html", site.principal);
  const script = await readProjectFile(site.project, "app.js", site.principal);
  if (!html.includes('<title>Nova Delivery</title>') || !script.includes('setTimeout') || !script.includes('restaurantsList.innerHTML')) return;
  await installRestaurantProject(site.principal, site.project);
  await markRestaurantProject(site.principal, site.project);
  console.log("Nova: reported restaurant publication upgraded with file backups.");
}

async function publishProject(principal, project) {
  try { await readProjectFile(project, "index.html", principal); }
  catch (error) {
    if (error.code === "ENOENT" || error.status === 404) throw Object.assign(new Error("Proiectul trebuie să conțină index.html înainte de publicare."), { status: 400 });
    throw error;
  }
  return withPublicationLock(async () => {
    await assertPrincipalActive(principal);
    const publications = await readPublications();
    const existing = Object.entries(publications.sites).find(([, site]) => site.principal === principal && site.project === project);
    const id = existing?.[0] || crypto.randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    publications.sites[id] = { principal, project, createdAt: existing?.[1].createdAt || now, updatedAt: now };
    await writePublications(publications);
    return { id, url: `/p/${id}/`, published: true, updatedAt: now };
  });
}

async function unpublishProject(principal, project) {
  return withPublicationLock(async () => {
    const publications = await readPublications();
    const existing = Object.entries(publications.sites).find(([, site]) => site.principal === principal && site.project === project);
    if (existing) {
      delete publications.sites[existing[0]];
      await writePublications(publications);
    }
    return { published: false };
  });
}

async function unpublishAllForPrincipal(principal) {
  return withPublicationLock(async () => {
    const publications = await readPublications();
    let changed = false;
    for (const [id, site] of Object.entries(publications.sites)) {
      if (site.principal !== principal) continue;
      delete publications.sites[id];
      changed = true;
    }
    if (changed) await writePublications(publications);
  });
}

async function servePublishedSite(req, res, id, requestedPath) {
  const publications = await readPublications();
  const site = publications.sites[id];
  if (!site || !(site.principal === "owner" || /^[a-f0-9]{32}$/.test(site.principal)) || !validProjectId(site.project)) {
    return json(res, 404, { error: "Site-ul publicat nu există." });
  }
  if (["", "index.html"].includes(requestedPath)) {
    let metadata = {};
    try { metadata = JSON.parse(await dataFs.promises.readFile(path.join(projectRoot(site.project, site.principal), ".nova-project.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (metadata.nativeBusinessType === "restaurant-marketplace-v1") {
      res.writeHead(302, { location: `/restaurants?site=${id}`, "cache-control": "no-store" });
      return res.end();
    }
  }
  let relative;
  try { relative = decodeURIComponent(requestedPath || "index.html").replace(/\\/g, "/"); }
  catch { return json(res, 400, { error: "Calea publică nu este validă." }); }
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") || part === "node_modules")) {
    return json(res, 403, { error: "Fișierul public solicitat nu este permis." });
  }
  const root = projectRoot(site.project, site.principal);
  const filePath = path.resolve(root, ...parts);
  if (!filePath.startsWith(`${root}${path.sep}`)) return json(res, 403, { error: "Calea publică nu este permisă." });
  let stat;
  try { stat = await dataFs.promises.lstat(filePath); }
  catch (error) { if (error.code === "ENOENT") return json(res, 404, { error: "Pagina publicată nu a fost găsită." }); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return json(res, 404, { error: "Fișierul publicat nu este disponibil." });
  const extension = path.extname(filePath).toLowerCase();
  if (!MIME[extension]) return json(res, 415, { error: "Formatul fișierului publicat nu este acceptat." });
  const headers = {
    "content-type": MIME[extension],
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:; form-action 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  return res.end(await dataFs.promises.readFile(filePath));
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

const { webTools, webPrompt, callWebTool, createWebHealthChecker } = require("./web-tools");

const checkWebHealth = createWebHealthChecker(undefined, Date.now, async () => ({ searchConfig: searchConfiguration() }));

const agentTools = [
  ...webTools,
  { type: "function", function: { name: "list_files", description: "List the files in the open project.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file from the open project.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Project-relative path, such as src/index.js" } }, additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or update a UTF-8 text file in the open project. Only call this when the user asked to implement changes.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string", description: "Project-relative file path" }, content: { type: "string", description: "Complete UTF-8 file content" } }, additionalProperties: false } } }
];

async function callAgentTool(name, args, project, allowChanges, principal = "owner") {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Argumente de unealtă invalide.");
  if (webTools.some(tool => tool.function.name === name)) return await callWebTool(name, args, undefined, { searchConfig: searchConfiguration() });
  if (name === "list_files") return JSON.stringify(await listProjectFiles(projectRoot(project, principal)));
  if (name === "read_file") return await readProjectFile(project, args.path, principal);
  if (name === "write_file") {
    if (!allowChanges) throw new Error("Scrierea este dezactivată. Activează «Permite modificări» pentru agent.");
    const result = await writeProjectFile(project, args.path, args.content, principal);
    return `Fișier ${result.action}: ${result.path}. O copie anterioară a fost salvată pentru anulare.`;
  }
  throw new Error(`Unealtă necunoscută: ${name}`);
}

function creationMessages(messages, role, encoding) {
  if (encoding !== undefined && encoding !== "base64-utf8") {
    throw Object.assign(new Error("Codificarea mesajelor nu este acceptată."), { status: 400 });
  }
  if (encoding === "base64-utf8") {
    if (!Array.isArray(messages)) throw Object.assign(new Error("Format de conversație invalid."), { status: 400 });
    messages = messages.map(message => {
      const content = message?.content;
      if (typeof content !== "string" || content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
        throw Object.assign(new Error("Codificarea unui mesaj este invalidă."), { status: 400 });
      }
      try {
        const bytes = Buffer.from(content, "base64");
        if (bytes.toString("base64") !== content) throw new Error("Noncanonical base64");
        const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        return { ...message, content: decoded };
      } catch { throw Object.assign(new Error("Codificarea unui mesaj este invalidă."), { status: 400 }); }
    });
  }
  let inputBudget = 18000;
  return (role === "owner" ? messages : messages.slice(-6)).map(message => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw Object.assign(new Error("Format de conversație invalid."), { status: 400 });
    }
    const content = role === "owner" ? message.content : message.content.slice(0, Math.min(6000, inputBudget));
    inputBudget -= content.length;
    return { role: message.role, content };
  });
}

function aiRequestLifecycle(res) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  if (res.destroyed) controller.abort();
  return { signal: controller.signal, dispose: () => res.off("close", cancel) };
}

async function runAgent(model, inputMessages, project, mode, allowChanges, task = "auto", principal = "owner", verifyWeb = false, signal, beforeTool) {
  const routing = {};
  verifyWeb = verifyWeb || automaticWebSearch(inputMessages);
  let webAttempted = false, retryWeb = false, webCalls = 0, webLimitNotified = false;
  const taskPrompts = creationPrompts;
  const prompt = mode === "review" && ["auto", "code"].includes(task)
    ? "Ești Nova, agent de revizie de cod. Inspectează proiectul cu uneltele list_files și read_file. Nu modifica fișierele. Identifică probleme reale, ordonează-le după severitate și indică fișierele relevante."
    : mode === "plan" && ["auto", "code"].includes(task)
      ? "Ești Nova, agent de planificare software. Explorează proiectul cu list_files și read_file, apoi prezintă un plan ordonat și clar. Nu modifica fișierele."
      : `Ești Nova, asistent de creație și programare. ${taskPrompts[task] || taskPrompts.auto} Explorează proiectul și fișierele relevante când cererea depinde de ele. Implementează cererile de cod folosind write_file numai când este permis. Păstrează schimbările la obiect și raportează fiecare fișier schimbat. Nu rula comenzi și nu pretinde că ai testat codul.`;
  const messages = [
    { role: "system", content: `${prompt}\n\nAi acces la fișierele proiectului deschis prin list_files, read_file și write_file. Nu ai terminal sau acces la alte dosare. ${webPrompt} ${accuracyPrompt()} ${verifyWeb ? "Verificarea pe internet este cerută explicit. Caută numai informațiile publice necesare întrebării; nu trimite conversația sau fișierele private în căutare." : ""} ${allowChanges ? "Modificările sunt permise pentru această cerere." : "Modificările sunt dezactivate pentru această cerere."} Păstrează căile relative în proiect și nu șterge fișiere.` },
    ...inputMessages
  ];
  const tools = allowChanges ? agentTools : agentTools.filter(tool => tool.function.name !== "write_file");
  const events = [];
  const sources = [];
  const requiredBusinessFiles = task === "business" && mode === "build" && allowChanges
    ? new Set(["index.html", "styles.css", "app.js"])
    : null;
  const writtenBusinessFiles = new Set();
  const owner = principal === "owner";
  const maxRounds = owner ? Infinity : 4;
  const maxWebCalls = owner ? Infinity : 4;
  let businessCompletionRequested = false;
  let failedToolBatch = null;
  try {
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    if (webCalls >= maxWebCalls && !webLimitNotified) {
      messages.push({ role: "system", content: "Limita de căutări a fost atinsă. Nu mai cere unelte web. Formulează acum răspunsul final folosind sursele și rezultatele deja disponibile; ignoră sursele care au eșuat." });
      webLimitNotified = true;
    }
    const activeTools = webCalls >= maxWebCalls ? tools.filter(tool => !webTools.some(webTool => webTool.function.name === tool.function.name)) : tools;
    const response = await providerChat(model, messages, activeTools, owner ? null : 1500, (verifyWeb && round === 0) || retryWeb, signal, routing);
    retryWeb = false;
    const message = response.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push(message);
    if (!calls.length && !webAttempted && !verifyWeb && round < maxRounds - 1 && needsWebRetry(message.content)) {
      retryWeb = true;
      webAttempted = true;
      verifyWeb = true;
      messages.push({ role: "system", content: "Înainte de răspuns, caută informațiile publice lipsă cu web_search. Nu include date private în căutare. Răspunde folosind rezultatele relevante și explică limitele dacă nu găsești dovezi." });
      continue;
    }
    if (!calls.length && requiredBusinessFiles) {
      const missing = [...requiredBusinessFiles].filter(file => !writtenBusinessFiles.has(file));
      if (missing.length && (!owner || !businessCompletionRequested) && round < maxRounds - 1) {
        businessCompletionRequested = true;
        messages.push({ role: "system", content: `Cererea nu este finalizată. Creează acum fișierele lipsă ${missing.join(", ")} folosind write_file, cu conținut complet și funcțional. Nu răspunde doar cu idei sau cod în mesaj.` });
        continue;
      }
      if (missing.length) throw Object.assign(new Error(`Motorul AI nu a creat fișierele obligatorii: ${missing.join(", ")}. Încearcă din nou sau alege alt model text.`), { status: 502 });
    }
    if (!calls.length) return { content: answerWithSources(message.content || "Agentul a terminat fără un răspuns text.", sources, verifyWeb), events, model: response.model || model, provider: response.provider, providerName: response.providerName };
    businessCompletionRequested = false;
    let toolCount = 0, successfulTools = 0;
    for (const call of calls) {
      signal?.throwIfAborted();
      await beforeTool?.();
      const name = call.function?.name;
      const isWebTool = ["web_search", "read_web_page"].includes(name);
      if (isWebTool) { webAttempted = true; webCalls += 1; }
      try {
      if (!owner && ++toolCount > 4) throw new Error("Limita de unelte pe pas a fost atinsă.");
      if (isWebTool && webCalls > maxWebCalls) throw new Error("Limita de căutări web a fost atinsă; redactează răspunsul din sursele existente.");
      let args = call.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      const result = await callAgentTool(name, args, project, allowChanges, principal);
      successfulTools += 1;
      if (webTools.some(tool => tool.function.name === name)) collectSources(result, sources);
        if (name === "write_file" && requiredBusinessFiles?.has(args.path)) writtenBusinessFiles.add(args.path);
        if (!isWebTool) events.push({ tool: name, ok: true, ...(name === "write_file" ? { path: projectFile(project, args.path, principal).relative } : {}), summary: name === "write_file" ? result : name === "list_files" ? "Lista de fișiere citită" : `Fișier citit: ${args.path}` });
        const toolResultLimit = webTools.some(tool => tool.function.name === name) ? 24000 : 10000;
        messages.push({ role: "tool", tool_call_id: call.id, content: owner ? String(result) : String(result).slice(0, toolResultLimit) });
      } catch (error) {
        if (!isWebTool) events.push({ tool: name || "unknown", ok: false, summary: error.message });
        messages.push({ role: "tool", tool_call_id: call.id, content: `Eroare: ${error.message}` });
      }
    }
    // A repeated batch of failed tools is an execution failure, not a creation quota.
    const failedBatch = successfulTools ? null : JSON.stringify(calls.map(call => call.function));
    if (failedBatch && failedBatch === failedToolBatch) break;
    failedToolBatch = failedBatch;
  }
  if (requiredBusinessFiles) {
    const missing = [...requiredBusinessFiles].filter(file => !writtenBusinessFiles.has(file));
    if (missing.length) throw Object.assign(new Error(`Motorul AI nu a creat fișierele obligatorii: ${missing.join(", ")}. Încearcă din nou sau alege alt model text.`), { status: 502 });
  }
  messages.push({ role: "system", content: "Oprește folosirea uneltelor și oferă acum răspunsul final, clar și complet. Folosește informațiile deja obținute, citează numai sursele valide și menționează concis ce nu a putut fi verificat." });
  const finalResponse = await providerChat(model, messages, [], owner ? null : 1500, false, signal, routing);
  return { content: answerWithSources(finalResponse.message?.content || "Nu am putut formula răspunsul final din sursele disponibile.", sources, verifyWeb), events, model: finalResponse.model || model, provider: finalResponse.provider, providerName: finalResponse.providerName };
  } catch (error) {
    // A failed final completion must not hide files already saved by this action.
    if (events.some(event => event.ok && event.tool === "write_file")) error.partialEvents = events;
    throw error;
  }
}

const businessRuns = new Map();
const businessContactRates = new Map();
const businessPublishedContent = "Site-ul este publicat online și poate primi cereri de la clienți. Plățile și emailurile automate necesită conectarea serviciilor respective.";
const businessRequestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function businessProjectForRequest(principal, requestId) {
  const directory = workspacePaths(principal).projects;
  const entries = await dataFs.promises.readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of entries) {
    if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
    try {
      const metadata = JSON.parse(await dataFs.promises.readFile(path.join(directory, entry.name, ".nova-project.json"), "utf8"));
      if (metadata.businessRequestId === requestId) return { project: { id: entry.name, name: metadata.name }, metadata };
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  return null;
}

async function writeProjectMetadata(filePath, metadata) {
  const temporary = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await dataFs.promises.writeFile(temporary, JSON.stringify(metadata, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await dataFs.promises.rename(temporary, filePath); }
  catch (error) { await dataFs.promises.unlink(temporary).catch(() => {}); throw error; }
}

async function updateBusinessProject(principal, project, requestId, values) {
  return withAccountsLock(async () => {
    await assertPrincipalActive(principal);
    const filePath = path.join(projectRoot(project.id, principal), ".nova-project.json");
    const metadata = JSON.parse(await dataFs.promises.readFile(filePath, "utf8"));
    if (metadata.businessRequestId !== requestId) throw Object.assign(new Error("Proiectul afacerii nu mai este disponibil."), { status: 409 });
    await writeProjectMetadata(filePath, { ...metadata, ...values });
  });
}

async function businessStatus(principal, entry) {
  const { project, metadata } = entry;
  let state = metadata.businessState, error = metadata.businessError;
  if (state === "building" && Date.now() > metadata.businessLeaseUntil) { state = "failed"; error = "Crearea site-ului a expirat. Ideea și proiectul au fost păstrate."; }
  const publication = state === "published" || metadata.businessPhase === "publicare" ? await publicationFor(principal, project.id) : null;
  if (publication) state = "published";
  if (state === "published" && !publication) { state = "failed"; error = "Publicarea acestui site a fost oprită."; }
  return {
    requestId: metadata.businessRequestId, state, phase: metadata.businessPhase || "generare", project,
    ...(state === "published" ? { content: businessPublishedContent, events: [], ...metadata.businessResult, publication: { published: true, id: publication.id, url: `/p/${publication.id}/`, project: project.id, business: true } } : {}),
    ...(state === "failed" ? { error: error || "Site-ul nu a putut fi finalizat." } : {})
  };
}

async function businessFiles(project, principal) {
  const files = {};
  for (const name of requiredBusinessFiles) {
    try { files[name] = await readProjectFile(project.id, name, principal); }
    catch (error) { if (error.code !== "ENOENT" && error.status !== 404) throw error; files[name] = ""; }
  }
  return files;
}

async function runBusinessBuild(principal, project, requestId, idea, model) {
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  let phase = "generare";
  const guard = async () => {
    signal.throwIfAborted();
    await assertPrincipalActive(principal);
    const entry = JSON.parse(await dataFs.promises.readFile(path.join(projectRoot(project.id, principal), ".nova-project.json"), "utf8"));
    if (entry.businessRequestId !== requestId || entry.businessState !== "building") throw Object.assign(new Error("Crearea afacerii a fost întreruptă."), { status: 409 });
  };
  try {
    let generated;
    const nativeRestaurant = isRestaurantMarketplaceIdea(idea);
    if (nativeRestaurant) {
      await guard();
      await installRestaurantProject(principal, project.id);
      generated = { events: requiredBusinessFiles.map(path => ({ tool: "write_file", ok: true, path })), providerName: "Nova Local" };
    } else try { generated = await runAgent(model, [{ role: "user", content: idea }], project.id, "build", true, "business", principal, false, signal, guard); }
    catch (error) {
      const files = await businessFiles(project, principal);
      if (!error.partialEvents?.some(event => event.ok && event.tool === "write_file") || validateBusinessFiles(files, { idea }).length) throw error;
      generated = { events: error.partialEvents };
    }
    await guard();
    phase = "verificare";
    await updateBusinessProject(principal, project, requestId, { businessPhase: phase });
    let files = await businessFiles(project, principal);
    let issues = validateBusinessFiles(files, { idea });
    if (issues.length) {
      phase = "reparare";
      await updateBusinessProject(principal, project, requestId, { businessPhase: phase });
      const fixed = await runAgent(model, [{ role: "user", content: `Finalizează site-ul pentru ideea: ${idea}\n${creationPrompts.business}\nCorectează problemele de verificare: ${issues.join(" ")} Nu pune întrebări. Nu înlocui integrările reale cu simulări sau mesaje de succes. Păstrează funcțiile existente, citește fișierele și salvează corecțiile cu write_file.` }], project.id, "build", true, "code", principal, false, signal, guard);
      generated.events = [...(generated.events || []), ...(fixed.events || [])];
      files = await businessFiles(project, principal);
      issues = validateBusinessFiles(files, { idea });
    }
    if (issues.length) throw Object.assign(new Error("Site-ul nu a trecut verificarea fișierelor: " + issues.join(" ")), { businessValidation: true });
    await guard();
    await writeProjectFile(project.id, "index.html", addBusinessContact(files["index.html"]), principal);
    await writeProjectFile(project.id, "nova-contact.js", businessContactScript, principal);
    if (nativeRestaurant) await markRestaurantProject(principal, project.id);
    await guard();
    phase = "publicare";
    await updateBusinessProject(principal, project, requestId, { businessPhase: phase });
    await publishProject(principal, project.id);
    await updateBusinessProject(principal, project, requestId, {
      businessState: "published", businessPhase: "finalizat",
      businessResult: {
        content: businessPublishedContent,
        events: generated.events || [], model: generated.model, provider: generated.provider, providerName: generated.providerName
      }
    });
  } catch (error) {
    const profile = aiConfig.profiles[error.provider] || activeTextProfile();
    const message = error.businessValidation ? error.message : phase === "generare" || phase === "reparare"
      ? friendlyTextProviderError(error, profile, model) : "Site-ul nu a putut fi publicat. Proiectul și fișierele au fost păstrate.";
    console.error("Nova Business failed:", { phase, status: error.status || 503, provider: profile?.id });
    await updateBusinessProject(principal, project, requestId, { businessState: "failed", businessPhase: phase, businessError: message }).catch(() => {});
  }
}

async function claimBusinessBuild(req, res, principal, account, idea, requestId) {
  const ideaHash = crypto.createHash("sha256").update(idea).digest("hex");
  return withAccountsLock(async () => {
    await assertPrincipalActive(principal);
    const existing = await businessProjectForRequest(principal, requestId);
    if (existing) {
      if (existing.metadata.businessIdeaHash !== ideaHash) throw Object.assign(new Error("Această cerere aparține altei idei."), { status: 409 });
      return { ...existing, start: false };
    }
    const nativeRestaurant = isRestaurantMarketplaceIdea(idea);
    const profile = activeTextProfile();
    if (!nativeRestaurant && !isProfileConfigured(profile)) throw Object.assign(new Error("Configurează un motor AI pentru a crea afacerea."), { status: 503 });
    let database, quota;
    if (account.role === "subscriber" && !nativeRestaurant) {
      database = await readAccounts();
      const record = database.users.find(user => user.id === principal);
      if (!record || record.deleting) throw Object.assign(new Error("Contul nu este disponibil."), { status: 401 });
      quota = consumeQuota(record, SUBSCRIBER_DAILY_AI_LIMIT, undefined, 1);
      res.setHeader("x-nova-ai-remaining", String(quota.remaining)); res.setHeader("x-nova-ai-limit", String(quota.limit)); res.setHeader("x-nova-ai-interval", quota.interval);
      if (!quota.allowed) throw Object.assign(new Error("Cota planului este epuizată. Încearcă după reînnoirea cotei."), { status: 429 });
    }
    const metadata = { businessRequestId: requestId, businessIdeaHash: ideaHash, businessState: "building", businessPhase: "generare", businessLeaseUntil: Date.now() + 15 * 60 * 1000 };
    const project = await createProjectWorkspace(businessProjectName(idea), principal, { empty: true, subscriber: account.role === "subscriber", metadata });
    if (database) await writeAccounts(database);
    return { project, metadata, model: profile.textModel, start: true };
  });
}

async function receiveBusinessContact(req, res, id) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Formularul acceptă numai trimiterea unei cereri." });
  const site = (await readPublications()).sites[id];
  if (!site || !validProjectId(site.project)) return json(res, 404, { error: "Site-ul nu mai este publicat." });
  await assertPrincipalActive(site.principal);
  const root = projectRoot(site.project, site.principal);
  const metadata = JSON.parse(await dataFs.promises.readFile(path.join(root, ".nova-project.json"), "utf8"));
  if (!metadata.businessRequestId) return json(res, 404, { error: "Formularul acestui site nu este activ." });
  const source = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  const rateKey = crypto.createHash("sha256").update(id + source).digest("hex");
  const now = Date.now();
  if (businessContactRates.size > 5000) for (const [key, rate] of businessContactRates) if (rate.until <= now) businessContactRates.delete(key);
  const rate = businessContactRates.get(rateKey);
  if (rate && rate.until > now && rate.count >= 20) return json(res, 429, { error: "Prea multe cereri. Încearcă din nou mai târziu." });
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, { error: "Formularul acceptă numai JSON." });
  const contact = normalizeBusinessContact(await readJson(req, 16384));
  businessContactRates.set(rateKey, rate && rate.until > now ? { ...rate, count: rate.count + 1 } : { until: now + 3600000, count: 1 });
  const directory = path.join(root, ".nova-leads");
  const key = `${now}-${crypto.randomBytes(8).toString("hex")}`;
  await dataFs.promises.mkdir(directory, { recursive: true });
  await dataFs.promises.writeFile(path.join(directory, key + ".json"), JSON.stringify({ id: key, ...contact, createdAt: new Date(now).toISOString() }), { encoding: "utf8", mode: 0o600 });
  return json(res, 201, { received: true });
}

async function probeTextProvider(profile, model, signal, timeout = 15000) {
  const callerSignal = signal;
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  try {
    const response = await chatWithResolvedTextModel(profile, model || profile.textModel, {
      messages: [{ role: "user", content: "Răspunde doar cu: Nova este conectată." }],
      maxOutputTokens: 1024, timeout, signal
    });
    signal?.throwIfAborted();
    const reply = String(response.message?.content || "").trim();
    if (!reply) throw Object.assign(new Error("Modelul nu a returnat text."), { status: 502, failureKind: "invalid_response" });
    providerStatus.success(profile, response);
    return { response, reply };
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (signal.aborted) error = Object.assign(new Error("Verificarea motorului a expirat."), { status: 504, failureKind: "timeout" });
    providerStatus.failure(profile, error, friendlyTextProviderError(error, profile, model || profile.textModel));
    throw error;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/version") {
    const commit = process.env.RENDER_GIT_COMMIT || "";
    return json(res, 200, {
      version: require("./package.json").version,
      release: "android-ios-installable-pwa-v1",
      commit: /^[a-f0-9]{40}$/i.test(commit) ? commit : null
    });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    try { await dataStore.healthCheck(); return json(res, 200, { ok: true }); }
    catch { return json(res, 503, { ok: false, error: "Storage unavailable" }); }
  }

  if (["GET", "HEAD"].includes(req.method) && url.pathname === "/robots.txt") {
    const body = "User-agent: *\nAllow: /\nAllow: /about\nAllow: /plans.html\nDisallow: /api/\nDisallow: /admin.html\nDisallow: /preview-orbit\nDisallow: /p/\nSitemap: https://www.nova-ai-studio.eu/sitemap.xml\n";
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
    return res.end(req.method === "HEAD" ? "" : body);
  }
  if (["GET", "HEAD"].includes(req.method) && url.pathname === "/sitemap.xml") {
    const body = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.nova-ai-studio.eu/</loc></url><url><loc>https://www.nova-ai-studio.eu/about</loc></url><url><loc>https://www.nova-ai-studio.eu/plans.html</loc></url></urlset>';
    res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
    return res.end(req.method === "HEAD" ? "" : body);
  }
  if (["GET", "HEAD"].includes(req.method) && url.pathname === "/share-image.png") {
    const image = await fs.promises.readFile(path.join(__dirname, "site", "media", "nova-publicitate-coperta.png"));
    res.writeHead(200, { "content-type": "image/png", "content-length": image.length, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
    return res.end(req.method === "HEAD" ? undefined : image);
  }
  if (["GET", "HEAD"].includes(req.method) && ["/downloads/android", "/downloads/Nova-AI-Studio-Android-2.3.1.apk"].includes(url.pathname)) {
    const version = require("./package.json").version;
    const asset = `Nova-AI-Studio-Android-${version}.apk`;
    res.writeHead(302, {
      location: `https://github.com/adyady0303-hash/nova-ai-studio/releases/download/v${version}/${asset}`,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    });
    return res.end();
  }
  const mobileAsset = { "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"], "/icon.svg": ["icon.svg", "image/svg+xml"], "/icon-192.png": ["icon-192.png", "image/png"], "/icon-512.png": ["icon-512.png", "image/png"], "/offline.html": ["offline.html", "text/html; charset=utf-8"], "/service-worker.js": ["service-worker.js", "text/javascript; charset=utf-8"] }[url.pathname];
  if (["GET", "HEAD"].includes(req.method) && mobileAsset) {
    const file = await fs.promises.readFile(path.join(PUBLIC_DIR, mobileAsset[0]));
    res.writeHead(200, { "content-type": mobileAsset[1], "cache-control": url.pathname === "/service-worker.js" ? "no-cache" : "public, max-age=86400", "service-worker-allowed": "/", "x-content-type-options": "nosniff" });
    return res.end(req.method === "HEAD" ? undefined : file);
  }
  if (["GET", "HEAD"].includes(req.method) && ["/about", "/privacy.html"].includes(url.pathname)) {
    const file = url.pathname === "/about" ? "index.html" : "privacy.html";
    const page = await fs.promises.readFile(path.join(__dirname, "site", file));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=900", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff" });
    return res.end(req.method === "HEAD" ? undefined : page);
  }

  const restaurantAsset = {
    "/restaurants": ["restaurants.html", "text/html; charset=utf-8"],
    "/restaurants/": ["restaurants.html", "text/html; charset=utf-8"],
    "/restaurants/manage": ["restaurant-manage.html", "text/html; charset=utf-8"],
    "/restaurants.css": ["restaurants.css", "text/css; charset=utf-8"],
    "/restaurants-app.js": ["restaurants-app.js", "text/javascript; charset=utf-8"],
    "/restaurant-manage.js": ["restaurant-manage.js", "text/javascript; charset=utf-8"]
  }[url.pathname];
  if (["GET", "HEAD"].includes(req.method) && restaurantAsset) {
    res.writeHead(200, { "content-type": restaurantAsset[1], "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "geolocation=(self)", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'" });
    return res.end(req.method === "HEAD" ? undefined : await fs.promises.readFile(path.join(PUBLIC_DIR, restaurantAsset[0])));
  }
  if (req.method === "GET" && url.pathname === "/api/restaurants/geocode") return restaurantResponse(res, async () => {
    restaurantRate(req, "geocode", 20);
    return restaurants.geocode(url.searchParams.get("q"));
  });
  if (req.method === "GET" && url.pathname === "/api/restaurants/search") return restaurantResponse(res, async () => {
    restaurantRate(req, "search", 120);
    return restaurants.search({ lat: url.searchParams.get("lat"), lon: url.searchParams.get("lon") });
  });
  const restaurantOrder = url.pathname.match(/^\/api\/restaurants\/([a-f0-9]{24})\/orders$/);
  if (req.method === "POST" && restaurantOrder) return restaurantResponse(res, async () => {
    if (!sameOrigin(req)) throw Object.assign(new Error("Cererea de comandă a fost respinsă."), { status: 403 });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw Object.assign(new Error("Comanda acceptă numai JSON."), { status: 415 });
    restaurantRate(req, "order", 10);
    return restaurants.order(restaurantOrder[1], await readJson(req));
  }, 201);

  const businessContact = url.pathname.match(/^\/p\/([a-f0-9]{24})\/contact$/);
  if (businessContact) return receiveBusinessContact(req, res, businessContact[1]);

  const publishedSite = ["GET", "HEAD"].includes(req.method) && url.pathname.match(/^\/p\/([a-f0-9]{24})(?:\/(.*))?$/);
  if (publishedSite) return servePublishedSite(req, res, publishedSite[1], publishedSite[2] || "index.html");

  if (req.method === "POST" && url.pathname === "/api/billing/webhook") {
    const result = await billing.webhook(await readBody(req), req.headers["stripe-signature"]);
    return json(res, 200, result);
  }
  if (["GET", "HEAD"].includes(req.method) && ["/preview-orbit", "/preview-orbit.html"].includes(url.pathname)) {
    const page = (await fs.promises.readFile(path.join(PUBLIC_DIR, "preview-orbit.html"), "utf8"))
      .replaceAll("__NOVA_VERSION__", require("./package.json").version);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
    return res.end(req.method === "HEAD" ? undefined : page);
  }
  if (req.method === "GET" && url.pathname === "/plans.html") {
    const page = await fs.promises.readFile(path.join(PUBLIC_DIR, "plans.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    return res.end(page);
  }
  if (req.method === "GET" && url.pathname === "/api/auth/options") return json(res, 200, { google: Boolean(ACCESS_PASSWORD && googleAuth.enabled) });
  if (ACCESS_PASSWORD && req.method === "GET" && url.pathname === "/api/auth/google") {
    try {
      const started = googleAuth.begin();
      res.writeHead(302, { location: started.url, "set-cookie": started.cookie, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    } catch (error) { return json(res, error.status || 503, { error: error.message }); }
  }
  if (ACCESS_PASSWORD && req.method === "GET" && url.pathname === "/api/auth/google/callback") return googleCallback(req, res, url);
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
  const accountDeletionRequest = req.method === "DELETE" && url.pathname === "/api/auth/account";
  if (account.deleting && !accountDeletionRequest) {
    if (["GET", "HEAD"].includes(req.method) && url.pathname === "/") return sendPendingDeletionPage(res, account, req.method === "HEAD");
    return json(res, 423, { error: "Ștergerea contului este în curs. Finalizează ștergerea sau autentifică-te mai târziu." });
  }
  if (accountDeletionRequest) {
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de ștergere respinsă." });
    if (account.role !== "subscriber") return json(res, 403, { error: "Contul owner nu poate fi șters din aplicație." });
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: "Confirmarea ștergerii nu este validă." }); }
    if (body.confirmation !== account.username) return json(res, 400, { error: "Scrie exact numele contului pentru confirmare." });
    try {
      await withAccountsLock(async () => {
        const database = await readAccounts();
        const record = database.users.find(user => user.id === principal);
        if (!record) throw Object.assign(new Error("Contul nu mai există."), { status: 404 });
        if (record.username !== account.username) throw Object.assign(new Error("Confirmarea contului nu mai este validă."), { status: 409 });
        if (!record.deleting) {
          record.deleting = true;
          record.deletion = { ...(record.deletion || {}), startedAt: new Date().toISOString() };
          await writeAccounts(database);
        }
      });
      await billing.closeAccount(account);
      await unpublishAllForPrincipal(principal);
      await restaurants.removeOwner(principal);
      await dataStore.deleteUserData(principal);
      await withAccountsLock(async () => {
        const database = await readAccounts();
        const index = database.users.findIndex(user => user.id === principal);
        if (index >= 0) {
          await dataStore.deleteSessionsForUser(principal);
          database.users.splice(index, 1);
          await writeAccounts(database);
        }
      });
      for (const [sessionToken, activeSession] of sessions) {
        if (activeSession.userId === principal) sessions.delete(sessionToken);
      }
      res.setHeader("set-cookie", AUTH_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + cookieSecurityAttribute());
      return json(res, 200, { deleted: true });
    } catch (error) {
      console.error("Nova account deletion failed:", error);
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 503;
      return json(res, status, { error: status === 503 ? "Contul nu a putut fi șters în siguranță. Reîncearcă." : error.message });
    }
  }
  if (url.pathname === "/api/restaurants/mine" && req.method === "GET") return restaurantResponse(res, async () => ({ restaurant: await restaurants.mine(principal) }));
  if (url.pathname === "/api/restaurants/mine/orders" && req.method === "GET") return restaurantResponse(res, async () => ({ orders: await restaurants.orders(principal) }));
  const merchantOrder = url.pathname.match(/^\/api\/restaurants\/mine\/orders\/([a-f0-9]{24})$/);
  if (url.pathname === "/api/restaurants/mine" && req.method === "PUT" || merchantOrder && req.method === "PATCH") return restaurantResponse(res, async () => {
    if (!sameOrigin(req)) throw Object.assign(new Error("Modificarea restaurantului a fost respinsă."), { status: 403 });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw Object.assign(new Error("Modificarea acceptă numai JSON."), { status: 415 });
    const body = await readJson(req);
    if (merchantOrder) return restaurants.updateOrder(principal, merchantOrder[1], body.status);
    return { restaurant: await restaurants.save(principal, body) };
  });
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
    return json(res, 200, { username: account.username, ...(record.displayName ? { displayName: record.displayName } : {}), role: account.role, id: account.userId, authEnabled: Boolean(ACCESS_PASSWORD), plan: quota.plan, quotaLimit: quota.limit, quotaRemaining: quota.remaining, quotaInterval: quota.interval, dailyLimit: quota.interval === "day" ? quota.limit : null, remainingToday: quota.interval === "day" ? quota.remaining : null });
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res, 200, { settings: publicProviderSettings(account.role) });
  }

  if (req.method === "GET" && url.pathname === "/api/ai/models") {
    if (account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate verifica modelele unui profil." });
    const id = url.searchParams.get("provider");
    const profile = Object.hasOwn(aiConfig.profiles, id || "") ? aiConfig.profiles[id] : null;
    if (!profile) return json(res, 400, { error: "Alege un profil AI valid." });
    const capability = url.searchParams.get("capability") || "text";
    if (!["text", "image"].includes(capability)) return json(res, 400, { error: "Capabilitatea solicitată nu este validă." });
    if (!profile.baseUrl || !profile.capabilities?.[capability] || ((profile.requiresKey || profile.id === "custom" && !localProviderUrl(profile)) && !profile.apiKey)) return json(res, 503, { error: `Configurează mai întâi cheia și profilul ${profile.name} pentru ${capability === "image" ? "imagini" : "text"}.` });
    const lifecycle = aiRequestLifecycle(res);
    try {
      if (capability === "image") {
        const models = await listProfileImageModels(profile, { timeout: 10000, signal: lifecycle.signal });
        return json(res, 200, { provider: id, capability, models,
          recommendedModel: models.includes(profile.imageModel) ? profile.imageModel : models[0] || "", configuredModel: profile.imageModel });
      }
      const catalog = await listProfileModels(profile, { timeout: 10000, signal: lifecycle.signal, fallback: false });
      const models = profile.id === "openai" ? availableOpenAiChatModels(catalog, "")
        : catalog.filter(model => !/(embed|embedding|imagen|image|dall|tts|speech|whisper|moderation|rerank|realtime|audio|robotics)/i.test(model));
      return json(res, 200, { provider: id, models, recommendedModel: models.length ? recommendedChatModel(profile, models) : "", configuredModel: profile.textModel });
    } catch (error) {
      return json(res, 502, { error: capability === "image" ? friendlyImageProviderError(error, profile, profile.imageModel) : friendlyTextProviderError(error, profile, profile.textModel), providerError: true });
    } finally { lifecycle.dispose(); }
  }

  if (url.pathname === "/api/ai/diagnostics") {
    if (account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate verifica toate motoarele AI." });
    if (req.method !== "POST") return json(res, 405, { error: "Verificarea motoarelor necesită POST." });
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de verificare respinsă." });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, { error: "Verificarea acceptă numai cereri JSON." });
    await readJson(req);
    const profiles = Object.values(aiConfig.profiles);
    const checks = profiles.filter(profile => textRoutingEligible(profile));
    const lifecycle = aiRequestLifecycle(res);
    let cursor = 0;
    const worker = async () => {
      while (cursor < checks.length) {
        lifecycle.signal.throwIfAborted();
        const profile = checks[cursor++];
        try { await probeTextProvider(profile, profile.textModel, lifecycle.signal); }
        catch (error) { lifecycle.signal.throwIfAborted(); }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(2, checks.length) }, () => worker()));
      const commit = process.env.RENDER_GIT_COMMIT || "";
      return json(res, 200, {
        version: require("./package.json").version,
        commit: /^[a-f0-9]{40}$/i.test(commit) ? commit : null,
        providers: profiles.map(profile => ({ id: profile.id, name: profile.name,
          configured: routeProfileConfigured(profile, "text"), eligible: textRoutingEligible(profile), status: providerStatus.get(profile) }))
      });
    } finally { lifecycle.dispose(); }
  }

  if (req.method === "GET" && url.pathname === "/api/web/health") {
    if (account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate verifica accesul web al serverului." });
    return json(res, 200, { ...await checkWebHealth(), version: require("./package.json").version });
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    if (account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate schimba furnizorul AI al platformei." });
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de configurare AI respinsă." });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
      return json(res, 415, { error: "Configurarea AI acceptă numai cereri JSON." });
    }
    const body = await readJson(req);
    const aliases = { google: "gemini", claude: "anthropic", compatible: "custom" };
    const explicitProviderId = aliases[String(body.providerId || "").trim().toLowerCase()] || String(body.providerId || "").trim().toLowerCase();
    let providerId = aliases[String(body.providerId || body.provider || "").trim().toLowerCase()] || String(body.providerId || body.provider || "").trim().toLowerCase();
    if (providerId === "openai" && typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      try {
        if (new URL(body.baseUrl).origin !== new URL(PLATFORM_PRESETS.openai.baseUrl).origin) {
          if (explicitProviderId === "openai") return json(res, 400, { error: "Pentru o adresă API diferită, alege profilul API compatibilă / custom." });
          providerId = "custom";
        }
      } catch { return json(res, 400, { error: "Adresa API nu este validă." }); }
    }
    if (!aiConfig.profiles[providerId]) return json(res, 400, { error: "Alege o platformă AI disponibilă." });
    const next = cloneAiConfig();
    let updatedProfile;
    try {
      updatedProfile = sanitizeProfileUpdate({ ...body, id: providerId }, next.profiles[providerId]);
    } catch (error) { return json(res, error.status || 400, { error: error.message }); }
    next.profiles[providerId] = updatedProfile;

    const requestedRoutes = body.routes && typeof body.routes === "object" && !Array.isArray(body.routes) ? body.routes : null;
    if (requestedRoutes) {
      if (typeof requestedRoutes.autoImageSelect === "boolean") next.routes.autoImageSelect = requestedRoutes.autoImageSelect;
      if (body.selectForImages === true) next.routes.autoImageSelect = false;
      for (const capability of ["text", "image", "speech"]) {
        const selected = capability === "text" && body.selectForChat === true || capability === "image" && body.selectForImages === true;
        const requested = String(selected ? providerId : requestedRoutes[capability] || "").trim().toLowerCase();
        const id = aliases[requested] || requested;
        if (!next.profiles[id]?.capabilities?.[capability]) return json(res, 400, { error: `Ruta pentru ${capability} nu este compatibilă cu motorul ales.` });
        if (!routeProfileConfigured(next.profiles[id], capability) && !(capability !== "text" && id === aiConfig.routes[capability])
          && !(capability === "image" && next.routes.autoImageSelect && next.profiles[id].apiKey)) {
          const label = capability === "image" ? "imagini" : capability === "speech" ? "voce" : "text";
          return json(res, 400, { error: `Motorul ${next.profiles[id].name} nu este configurat complet pentru ${label}.` });
        }
        next.routes[capability] = id;
      }
      next.routes.autoSelect = requestedRoutes.autoSelect !== false;
      next.routes.autoFallback = requestedRoutes.autoFallback === true;
    } else {
      next.routes.text = providerId;
      if (routeProfileConfigured(updatedProfile, "image")) next.routes.image = providerId;
      if (routeProfileConfigured(updatedProfile, "speech")) next.routes.speech = providerId;
    }
    if (body.selectForImages === true) {
      if (!routeProfileConfigured(updatedProfile, "image")) return json(res, 400, { error: "Configurează cheia și modelul pentru motorul de imagini ales." });
      next.routes.image = providerId;
      next.routes.autoImageSelect = false;
    }
    if (body.selectForChat === true) {
      if (!routeProfileConfigured(updatedProfile, "text")) return json(res, 400, { error: "Configurează cheia și modelul motorului ales pentru chat." });
      next.routes.text = providerId;
      next.routes.autoSelect = false;
      next.routes.autoFallback = false;
    }
    const activeAfterSave = next.profiles[next.routes.text];
    if (!routeProfileConfigured(activeAfterSave, "text")) {
      if (routeProfileConfigured(updatedProfile, "text")) next.routes.text = providerId;
      else return json(res, 400, { error: `Motorul ${activeAfterSave?.name || "AI"} nu este configurat complet. Adaugă cheia și modelul.` });
    }
    if (body.search && typeof body.search === "object" && !Array.isArray(body.search)) {
      const searchProvider = String(body.search.provider || "").trim().toLowerCase();
      if (!["auto", "bing", "brave", "tavily"].includes(searchProvider)) return json(res, 400, { error: "Motorul de căutare nu este valid." });
      next.search.provider = searchProvider;
      if (["brave", "tavily"].includes(searchProvider)) {
        if (body.search.clearApiKey === true) next.search.keys[searchProvider] = "";
        else if (typeof body.search.apiKey === "string" && body.search.apiKey.trim()) next.search.keys[searchProvider] = body.search.apiKey.trim().slice(0, 4000);
      }
    }
    await persistAiSettings(next);
    aiConfig = next;
    return json(res, 200, { settings: publicProviderSettings(account.role), notice: "Profilurile și cheile AI sunt sincronizate între instanțe; secretele sunt criptate și nu sunt returnate în interfață." });
  }

  if (req.method === "POST" && url.pathname === "/api/media/image") {
    let profile, imageModel;
    const lifecycle = aiRequestLifecycle(res);
    try {
      profile = routeProfile("image");
      const candidates = imageRoutingProfiles(false);
      if (!candidates.length) throw Object.assign(new Error("Configurează o cheie și un motor de imagini în Motoare AI."), { status: 503 });
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? (account.role === "owner" ? body.prompt.trim() : body.prompt.trim().slice(0, 4000)) : "";
      if (!prompt) return json(res, 400, { error: "Descrie imaginea pe care vrei să o creezi." });
      if (!await consumeAiQuota(req, res)) return;
      return json(res, 200, await routedImage(prompt, null, candidates, lifecycle.signal));
    } catch (error) { if (res.destroyed) return; profile = aiConfig.profiles[error.provider] || profile; return json(res, error.status || 502, { error: profile ? friendlyImageProviderError(error, profile, imageModel || profile.imageModel) : (error.message || "Generarea imaginii a eșuat."), providerError: true }); }
    finally { lifecycle.dispose(); }
  }

  if (req.method === "POST" && url.pathname === "/api/media/image/edit") {
    let profile, imageModel;
    const lifecycle = aiRequestLifecycle(res);
    try {
      profile = routeProfile("image");
      const candidates = imageRoutingProfiles(true);
      if (!candidates.length) throw Object.assign(new Error("Configurează o cheie și un motor de imagini în Motoare AI."), { status: 503 });
      const body = await readJson(req, MAX_IMAGE_EDIT_BODY);
      const prompt = typeof body.prompt === "string" ? (account.role === "owner" ? body.prompt.trim() : body.prompt.trim().slice(0, 4000)) : "";
      if (!prompt) return json(res, 400, { error: "Descrie schimbarea pe care o dorești în fotografie." });
      const source = uploadedImage(body.image);
      if (!await consumeAiQuota(req, res)) return;
      return json(res, 200, await routedImage(prompt, source, candidates, lifecycle.signal));
    } catch (error) { if (res.destroyed) return; profile = aiConfig.profiles[error.provider] || profile; return json(res, error.status || 502, { error: profile ? friendlyImageProviderError(error, profile, imageModel || profile.imageModel) : (error.message || "Modificarea imaginii a eșuat."), providerError: true }); }
    finally { lifecycle.dispose(); }
  }

  if (req.method === "POST" && url.pathname === "/api/media/speech") {
    try {
      const profile = requireRouteProfile("speech");
      if (profile.protocol !== "openai") throw Object.assign(new Error(`Motorul ${profile.name} nu oferă sinteză vocală compatibilă.`), { status: 503 });
      const body = await readJson(req);
      const input = typeof body.text === "string" ? body.text.trim() : "";
      if (!input) return json(res, 400, { error: "Adaugă text pentru voice-over." });
      if (input.length > 4096) return json(res, 400, { error: "Vocea acceptă cel mult 4096 de caractere. Împarte textul în fragmente." });
      const voiceOptions = speechOptions(body);
      if (!await consumeAiQuota(req, res, Math.ceil(input.length / 500))) return;
      const speech = await openAiCompatibleBytes(profile, "/audio/speech", {
        model: profile.speechModel,
        voice: profile.voice,
        ...voiceOptions,
        input,
        response_format: "mp3",
        ...(profile.speechModel.startsWith("gpt-4o-mini-tts") ? { instructions: "Vorbește clar, natural și expresiv în limba textului." + " Păstrează sensul și cuvintele textului. Când textul este în română, pronunță corect diacriticele și folosește pauze firești la punctuație. Recită textul; nu adăuga explicații și nu cânta." } : {})
      }, { timeout: 300000 });
      return json(res, 200, { dataUrl: `data:${speech.mime};base64,${speech.base64}`, model: profile.speechModel, provider: profile.id, providerName: profile.name });
    } catch (error) { return json(res, error.status || 502, { error: error.message || "Generarea vocii a eșuat.", providerError: true }); }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/test") {
    const body = await readJson(req);
    if (body.providerId && account.role !== "owner") return json(res, 403, { error: "Doar administratorul poate alege profilul verificat." });
    const profile = body.providerId && Object.hasOwn(aiConfig.profiles, body.providerId) ? aiConfig.profiles[body.providerId] : body.providerId ? null : activeTextProfile();
    if (!profile) return json(res, 400, { connected: false, error: "Alege un profil AI valid." });
    const requestedModel = account.role === "owner" ? body.model : profile.textModel;
    const model = String(requestedModel || profile.textModel || "").trim().slice(0, 240);
    if (!model) return json(res, 400, { connected: false, error: "Alege un model AI înainte de test." });
    if (!isProfileConfigured(profile)) {
      const error = profile.id === "openai"
        ? "Cheia API OpenAI lipsește din configurarea serverului."
        : `Motorul ${profile.name} nu este configurat complet.`;
      return json(res, 503, { connected: false, provider: publicProviderId(profile), error });
    }
    if (!await consumeAiQuota(req, res)) return;
    const lifecycle = aiRequestLifecycle(res);
    try {
      const { response, reply } = await probeTextProvider(profile, model, lifecycle.signal, 30000);
      return json(res, 200, { connected: true, provider: publicProviderId(profile), model: response.model || model, reply: reply.slice(0, 240) });
    } catch (error) {
      console.error("Nova AI connection test failed:", { provider: profile.id, status: error.status || 502 });
      const status = error.status;
      const message = ["openai", "custom"].includes(profile.id) && [401, 403].includes(status)
        ? "OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render."
        : friendlyTextProviderError(error, profile, model);
      return json(res, 502, { connected: false, provider: publicProviderId(profile), error: message });
    } finally { lifecycle.dispose(); }
  }
  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = [];
    const projectsDir = workspacePaths(principal).projects;
    await dataFs.promises.mkdir(projectsDir, { recursive: true });
    for (const entry of await dataFs.promises.readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
      let name = entry.name;
      try { name = JSON.parse(await dataFs.promises.readFile(path.join(projectsDir, entry.name, ".nova-project.json"), "utf8")).name || name; } catch {}
      const files = await listProjectFiles(path.join(projectsDir, entry.name));
      const rootStat = await dataFs.promises.stat(path.join(projectsDir, entry.name));
      const updatedAt = files.reduce((latest, file) => file.modified > latest ? file.modified : latest, rootStat.mtime.toISOString());
      projects.push({ id: entry.name, name, fileCount: files.length, updatedAt });
    }
    return json(res, 200, { projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name)) });
  }

  if (url.pathname === "/api/business") {
    if (req.method === "GET") {
      const requestId = url.searchParams.get("requestId") || "";
      if (!businessRequestPattern.test(requestId)) return json(res, 400, { error: "Cererea afacerii nu este validă." });
      const entry = await businessProjectForRequest(principal, requestId);
      return entry ? json(res, 200, await businessStatus(principal, entry)) : json(res, 404, { error: "Cererea afacerii nu există." });
    }
    if (req.method !== "POST") return json(res, 405, { error: "Metodă neacceptată." });
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de creare a afacerii respinsă." });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, { error: "Crearea afacerii acceptă numai JSON." });
    const body = await readCreationJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Descrie ideea de afacere într-un mesaj." });
    const requestId = String(body.requestId || "");
    if (!businessRequestPattern.test(requestId)) return json(res, 400, { error: "Identificatorul cererii nu este valid." });
    if (body.idea == null && !Array.isArray(body.messages)) return json(res, 400, { error: "Descrie ideea de afacere într-un mesaj." });
    const decoded = body.idea == null ? creationMessages(body.messages, account.role, body.messagesEncoding) : null;
    const idea = typeof body.idea === "string" ? body.idea.trim() : decoded?.filter(message => message.role === "user").at(-1)?.content.trim();
    if (!idea || account.role !== "owner" && idea.length > 6000) return json(res, 400, { error: "Descrie ideea de afacere într-un mesaj." });
    const claim = await claimBusinessBuild(req, res, principal, account, idea, requestId);
    if (claim.start) {
      const key = principal + ":" + requestId;
      const pending = runBusinessBuild(principal, claim.project, requestId, idea, claim.model);
      businessRuns.set(key, pending);
      pending.finally(() => businessRuns.delete(key)).catch(() => {});
    }
    const entry = await businessProjectForRequest(principal, requestId);
    return json(res, claim.start || entry.metadata.businessState === "building" ? 202 : 200, await businessStatus(principal, entry));
  }

  if (req.method === "GET" && url.pathname === "/api/business/leads") {
    const project = url.searchParams.get("project");
    const root = projectRoot(project, principal);
    await assertProjectParent({ root, full: path.join(root, "index.html") });
    const directory = path.join(root, ".nova-leads");
    const before = url.searchParams.get("before") || "";
    const names = (await dataFs.promises.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error)))
      .filter(name => /^\d{13}-[a-f0-9]{16}\.json$/.test(name) && (!before || name < before)).sort().reverse();
    const selected = names.slice(0, 50), leads = [];
    for (const name of selected) leads.push(JSON.parse(await dataFs.promises.readFile(path.join(directory, name), "utf8")));
    return json(res, 200, { leads, next: names.length > selected.length ? selected.at(-1) : null });
  }

  if (req.method === "POST" && url.pathname === "/api/cv") {
    if (!sameOrigin(req)) return json(res, 403, { error: "Cerere de creare CV respinsă." });
    const body = await readJson(req);
    const requestId = cvField(body?.requestId, 64);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
      return json(res, 400, { error: "Identificatorul cererii CV nu este valid." });
    }
    const cv = buildCvFiles(body);
    const project = await withAccountsLock(async () => {
      const existing = await projectForCvRequest(principal, requestId);
      const selected = existing || await createProjectWorkspace(cv.projectName, principal, {
        empty: true, subscriber: account.role === "subscriber", metadata: { cvRequestId: requestId }
      });
      for (const [filePath, content] of Object.entries(cv.files)) await writeProjectFile(selected.id, filePath, content, principal);
      return selected;
    });
    const publication = await publishProject(principal, project.id);
    return json(res, 201, { project, publication });
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    const project = await withAccountsLock(() => createProjectWorkspace(body.name, principal, { empty: body.empty === true, subscriber: account.role === "subscriber" }));
    return json(res, 201, { project });
  }

  if (req.method === "POST" && url.pathname === "/api/project/rename") {
    const body = await readJson(req);
    const root = projectRoot(body.project, principal);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return json(res, 400, { error: "Numele trebuie să aibă între 1 și 80 de caractere." });
    await withAccountsLock(async () => {
      const metadataPath = path.join(root, ".nova-project.json");
      let metadata = {};
      try { metadata = JSON.parse(await dataFs.promises.readFile(metadataPath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await writeProjectMetadata(metadataPath, { ...metadata, name: body.name.trim() });
    });
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
    await unpublishProject(principal, body.project);
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

  if (req.method === "GET" && url.pathname === "/api/project/publication") {
    const project = url.searchParams.get("project");
    projectRoot(project, principal);
    const publication = await publicationFor(principal, project);
    return json(res, 200, publication ? { published: true, id: publication.id, url: `/p/${publication.id}/`, updatedAt: publication.updatedAt } : { published: false });
  }

  if (req.method === "POST" && url.pathname === "/api/project/publish") {
    const body = await readJson(req);
    if (!validProjectId(body.project)) return json(res, 400, { error: "Alege un proiect valid pentru publicare." });
    const publication = await publishProject(principal, body.project);
    return json(res, 200, publication);
  }

  if (req.method === "POST" && url.pathname === "/api/project/unpublish") {
    const body = await readJson(req);
    if (!validProjectId(body.project)) return json(res, 400, { error: "Alege un proiect valid." });
    projectRoot(body.project, principal);
    return json(res, 200, await unpublishProject(principal, body.project));
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
    const body = await readCreationJson(req);
    if (["music", "video"].includes(body.task)) return json(res, 410, { error: "Instrumentul solicitat a fost eliminat din Nova AI Studio." });
    if (typeof body.model !== "string" || !body.model.trim()) return json(res, 400, { error: "Alege un model AI în bara de chat." });
    if (!validProjectId(body.project)) return json(res, 400, { error: "Alege un proiect." });
    if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: "Trimite o cerere agentului." });
    const mode = ["build", "plan", "review"].includes(body.mode) ? body.mode : "build";
    const safeMessages = creationMessages(body.messages, account.role);
    const task = Object.hasOwn(creationPrompts, body.task) ? body.task : "auto";
    const allowAgentChanges = mode === "build" && (account.role === "owner" || body.allowChanges === true);
    const model = account.role === "owner" ? body.model.trim() : activeTextProfile().textModel;
    if (!await consumeAiQuota(req, res)) return;
    const lifecycle = aiRequestLifecycle(res);
    try {
      const result = await runAgent(model, safeMessages, body.project, mode, allowAgentChanges, task, principal, body.verifyWeb === true, lifecycle.signal);
      return json(res, 200, result);
    } catch (error) {
      const profile = aiConfig.profiles[error?.provider] || activeTextProfile();
      const requestIssue = Number(error.status) !== 400 ? undefined
        : /thought.?signature/i.test(String(error.message)) ? "thought_signature"
          : /parameters|schema|function_declarations/i.test(String(error.message)) ? "tool_schema" : "other_request";
      console.error("Nova AI agent provider failed:", { provider: profile.id, status: error.status || 503, requestIssue });
      const unavailable = !isProfileConfigured(profile)
        ? `Motorul ${profile.name} nu este configurat complet. Deschide Motoare AI în setările Nova.`
        : friendlyTextProviderError(error, profile, model);
      return json(res, 503, { error: unavailable, providerError: true,
        ...(Array.isArray(error.partialEvents) ? { partial: true, events: error.partialEvents } : {}) });
    } finally { lifecycle.dispose(); }
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const profile = activeTextProfile();
    const provider = publicProviderId(profile);
    const chatStatus = providerStatus.get(profile);
    const observedChat = chatStatus.state === "unchecked" ? {} : { chatStatus };
    if (!isProfileConfigured(profile)) {
      const message = profile.id === "openai"
        ? "Cheia API OpenAI lipsește din configurarea serverului."
        : `Motorul ${profile.name} nu este configurat complet.`;
      return json(res, 200, { connected: false, provider, ...observedChat, providerName: profile.name, error: message, models: [] });
    }
    try {
      let availableModels = await cachedProfileModels(profile);
      if (profile.id === "openai") availableModels = availableOpenAiChatModels(availableModels, profile.textModel);
      else {
        const nonChat = /(embed|embedding|image|dall|tts|speech|whisper|moderation|rerank|realtime|audio)/i;
        availableModels = availableModels.filter(model => !nonChat.test(model));
        if (!availableModels.length && profile.textModel) availableModels = [profile.textModel];
      }
      const fallbacks = configuredFallbackProfiles(profile).slice(0, 1).map(item => ({ provider: item.id, providerName: item.name, model: item.textModel }));
      const recommendedModel = recommendedChatModel(profile, availableModels);
      return json(res, 200, {
        connected: true,
        provider,
        ...observedChat,
        providerName: profile.name,
        version: "Conexiune verificată",
        recommendedModel,
        models: account.role === "owner" ? availableModels : recommendedModel ? [recommendedModel] : [],
        ...(fallbacks.length ? { fallbacks } : {})
      });
    } catch (error) {
      const status = error.status;
      if (profile.id === "custom" && [404, 405, 501].includes(status)) {
        const fallbacks = configuredFallbackProfiles(profile).slice(0, 1).map(item => ({ provider: item.id, providerName: item.name, model: item.textModel }));
        return json(res, 200, {
          connected: true,
          provider,
          providerName: profile.name,
          ...observedChat,
          version: "Profil configurat · catalog /models indisponibil",
          models: profile.textModel ? [profile.textModel] : [],
          ...(fallbacks.length ? { fallbacks } : {})
        });
      }
      const openAiCompatible = profile.id === "openai" || profile.id === "custom";
      const message = openAiCompatible && (status === 401 || status === 403)
        ? "OpenAI a respins cheia API. Verifică OPENAI_API_KEY în Render."
        : status === 429
          ? `${profile.name} a limitat verificarea. Verifică limitele și facturarea API.`
          : status === 404
            ? `${profile.name} nu oferă ruta de catalog /models. Verifică adresa API și modelul.`
            : `Serverul nu a putut valida conexiunea ${profile.name}. Verifică rețeaua și configurarea API.`;
      return json(res, 200, { connected: false, provider, ...observedChat, providerName: profile.name, error: message, models: [] });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let requestedModel = "";
    const lifecycle = aiRequestLifecycle(res);
    try {
      const body = await readCreationJson(req);
      requestedModel = typeof body.model === "string" ? body.model.trim() : "";
      const task = ["text", "lyrics"].includes(body.task) ? body.task : "auto";
      if (typeof body.model !== "string" || !body.model.trim()) {
        return json(res, 400, { error: "Alege un model AI înainte să trimiți mesajul." });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, { error: "Adaugă un mesaj pentru model." });
      }

      const messages = creationMessages(body.messages, account.role);
      const model = account.role === "owner" ? body.model.trim() : activeTextProfile().textModel;
      if (!await consumeAiQuota(req, res)) return;

      const creationInstruction = task === "auto"
        ? "Ești Nova, un asistent AI online pentru programare și creație. Ajută la analizarea și scrierea codului. Când propui modificări, oferă blocuri de cod complete cu etichete de limbaj și numele fișierului. Nu pretinde că ai schimbat fișiere sau ai rulat comenzi; nu ai acces la sistemul de fișiere ori la terminal. Menționează clar presupunerile și riscurile relevante."
        : `Ești Nova, un asistent de creație. ${creationPrompts[task]} Livrează direct rezultatul final, fără plan preliminar și fără să ceri acces la proiect.`;
      const chatMessages = [
            {
              role: "system",
              content: `${creationInstruction} Răspunde în limba utilizatorului. ${task === "auto" ? `${webPrompt} ${accuracyPrompt()}` : accuracyPrompt()}`
            },
            ...messages
          ];
      let result;
      const routing = {};
      let verifyWeb = task === "auto" && (body.verifyWeb === true || automaticWebSearch(messages));
      let webAttempted = false, retryWeb = false, webCalls = 0, webLimitNotified = false;
      let failedToolBatch = null;
      const owner = account.role === "owner";
      const maxWebCalls = owner ? Infinity : 4;
      const maxRounds = owner ? Infinity : 4;
      const sources = [];
      for (let round = 0; round < maxRounds; round++) {
        lifecycle.signal.throwIfAborted();
        if (webCalls >= maxWebCalls && !webLimitNotified) {
          chatMessages.push({ role: "system", content: "Limita de căutări a fost atinsă. Nu mai cere unelte web. Răspunde acum folosind rezultatele și sursele valide deja disponibile." });
          webLimitNotified = true;
        }
        const activeTools = task === "auto" && webCalls < maxWebCalls ? webTools : [];
        result = await providerChat(model, chatMessages, activeTools, account.role === "subscriber" ? 1500 : null, (verifyWeb && round === 0) || retryWeb, lifecycle.signal, routing);
        retryWeb = false;
        const message = result.message || {};
        if (task === "auto" && !message.tool_calls?.length && !webAttempted && !verifyWeb && round < maxRounds - 1 && needsWebRetry(message.content)) {
          chatMessages.push(message, { role: "system", content: "Caută automat informațiile publice lipsă cu web_search, fără date private. Răspunde în limba utilizatorului folosind sursele relevante." });
          retryWeb = true;
          webAttempted = true;
          verifyWeb = true;
          continue;
        }
        if (!message.tool_calls?.length) break;
        chatMessages.push(message);
        let toolCount = 0, successfulTools = 0;
        for (const call of message.tool_calls) {
          lifecycle.signal.throwIfAborted();
          let content;
          try {
            if (!owner && ++toolCount > 4) throw new Error("Limita de unelte pe pas a fost atinsă.");
            if (++webCalls > maxWebCalls) throw new Error("Limita de căutări web a fost atinsă; redactează răspunsul din sursele existente.");
            const args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : call.function?.arguments;
            if (!args || typeof args !== "object") throw new Error("Argumente invalide.");
            webAttempted = true;
            content = await callWebTool(call.function.name, args, undefined, { searchConfig: searchConfiguration() });
            successfulTools += 1;
            collectSources(content, sources);
          } catch (error) { content = `Eroare: ${error.message}`; }
          chatMessages.push({ role: "tool", tool_call_id: call.id, content });
        }
        result = { message: { content: "Am atins limita de căutări web. Trimite o cerere de continuare." } };
        const failedBatch = successfulTools ? null : JSON.stringify(message.tool_calls.map(call => call.function));
        if (failedBatch && failedBatch === failedToolBatch) break;
        failedToolBatch = failedBatch;
      }
      if (result?.message?.tool_calls?.length || result?.message?.content === "Am atins limita de căutări web. Trimite o cerere de continuare.") {
        chatMessages.push({ role: "system", content: "Oprește căutarea și oferă acum răspunsul final, clar și complet, din informațiile deja obținute. Citează numai sursele valide." });
        result = await providerChat(model, chatMessages, [], account.role === "subscriber" ? 1500 : null, false, lifecycle.signal, routing);
      }
      return json(res, 200, {
        content: answerWithSources(result.message?.content || "Modelul nu a returnat text.", sources, verifyWeb),
        model: result.model || model,
        provider: result.provider,
        providerName: result.providerName,
        done: true
      });
    } catch (error) {
      const profile = aiConfig.profiles[error?.provider] || activeTextProfile();
      const providerAuthFailure = error.status === 401 || error.status === 403;
      return json(res, providerAuthFailure ? 502 : (error.status || 502), {
        error: friendlyTextProviderError(error, profile, requestedModel),
        providerError: true
      });
    } finally { lifecycle.dispose(); }
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
    const extension = path.extname(filePath).toLowerCase();
    const versionedAsset = [".css", ".js"].includes(extension) && url.searchParams.has("v");
    const cacheControl = extension === ".html"
      ? "no-cache"
      : versionedAsset ? "public, max-age=31536000, immutable" : "public, max-age=86400";
    res.writeHead(200, {
      "content-type": MIME[extension] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": cacheControl
    });
    if (req.method === "HEAD") return res.end();
    res.end(extension === ".html" ? data.toString("utf8").replaceAll("__NOVA_VERSION__", require("./package.json").version) : data);
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
  await initializeAiEncryption();
  await refreshAiSettings(true);
  await upgradeReportedRestaurantSite().catch(error => console.error("Nova restaurant publication repair failed:", { code: error.code || "repair_failed" }));
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

