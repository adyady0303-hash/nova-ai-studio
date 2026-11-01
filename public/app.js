const el = id => document.getElementById(id);
const state = { projects: [], project: null, files: [], activePath: null, dirty: false, chat: [], busy: false, filter: "", settings: null, account: null, publication: null, view: "home" };
let activeMessageStream = null;
let providerDraftDirty = false, searchDraftDirty = false, editingProviderId = "", editingSearchProvider = "";
let voiceRecognition = null, speakNextAssistant = false;
const fileIcons = { js: "JS", mjs: "JS", cjs: "JS", ts: "TS", py: "PY", md: "MD", css: "{}", html: "<>", json: "{}", gpc: "GPC" };
const providerNames = {
  openai: "OpenAI", gemini: "Gemini", anthropic: "Anthropic Claude", openrouter: "OpenRouter",
  groq: "Groq", mistral: "Mistral", deepseek: "DeepSeek", xai: "xAI", together: "Together",
  ollama: "Ollama", compatible: "API compatibilă", custom: "API compatibilă"
};
const defaultSearchProviders = [
  { id: "auto", name: "Auto", keyConfigured: false, requiresKey: false },
  { id: "bing", name: "Bing", keyConfigured: false, requiresKey: false },
  { id: "brave", name: "Brave", keyConfigured: false, requiresKey: true },
  { id: "tavily", name: "Tavily", keyConfigured: false, requiresKey: true }
];

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const remaining = response.headers.get("x-nova-ai-remaining");
  if (remaining !== null && state.account?.role === "subscriber") {
    state.account.remainingToday = Number(remaining);
    state.account.quotaRemaining = Number(remaining);
    state.account.quotaLimit = Number(response.headers.get("x-nova-ai-limit") || state.account.quotaLimit);
    state.account.quotaInterval = response.headers.get("x-nova-ai-interval") || state.account.quotaInterval;
    updateAccountLabel();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !data.providerError) window.location.replace("/?session=expired");
    throw new Error(data.error || `Cererea a eșuat (${response.status}).`);
  }
  return data;
}
function jsonBody(value) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }; }
function toast(text) { const node = el("toast"); node.textContent = text; node.classList.add("show"); setTimeout(() => node.classList.remove("show"), 2200); }

function updateVoiceChatButtons(listening) {
  for (const id of ["voiceChatBtn", "homeVoiceChatBtn"]) {
    const button = el(id); if (!button) continue;
    button.classList.toggle("listening", listening);
    button.setAttribute("aria-pressed", String(listening));
    button.title = listening ? "Oprește ascultarea" : "Vorbește cu Nova";
    button.setAttribute("aria-label", button.title);
  }
}

function speakChatReply(text) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance !== "function") return;
  const clean = String(text || "").replace(/```[\s\S]*?```/g, " fragment de cod ").replace(/[*_#`>~-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
  if (!clean) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = "ro-RO"; utterance.rate = 1; utterance.pitch = 1;
  const romanianVoice = speechSynthesis.getVoices().find(voice => /^ro(?:-|_)/i.test(voice.lang));
  if (romanianVoice) utterance.voice = romanianVoice;
  speechSynthesis.speak(utterance);
}

function startVoiceChat(targetId) {
  if (voiceRecognition) { voiceRecognition.stop(); return; }
  if (state.busy) { toast("Așteaptă răspunsul Nova înainte de un mesaj vocal nou."); return; }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (typeof Recognition !== "function") { toast("Recunoașterea vocală nu este disponibilă în acest browser. Folosește Chrome, Edge sau Safari actualizat."); return; }
  const target = el(targetId), original = target.value.trim();
  const recognition = new Recognition();
  let finalTranscript = "", recognitionError = "";
  recognition.lang = "ro-RO"; recognition.continuous = false; recognition.interimResults = true; recognition.maxAlternatives = 1;
  recognition.onstart = () => { voiceRecognition = recognition; updateVoiceChatButtons(true); toast("Ascult… vorbește acum."); };
  recognition.onresult = event => {
    let finalText = "", interimText = "";
    for (let index = 0; index < event.results.length; index++) {
      const transcript = String(event.results[index][0]?.transcript || "").trim();
      if (event.results[index].isFinal) finalText += `${transcript} `; else interimText += `${transcript} `;
    }
    finalTranscript = finalText.trim();
    target.value = [original, finalText.trim(), interimText.trim()].filter(Boolean).join(" ");
    if (targetId === "prompt") resizePrompt();
  };
  recognition.onerror = event => {
    recognitionError = event.error || "unknown";
    if (recognitionError === "not-allowed" || recognitionError === "service-not-allowed") toast("Permite accesul la microfon pentru a vorbi cu Nova.");
    else if (recognitionError !== "aborted" && recognitionError !== "no-speech") toast("Nu am putut recunoaște vocea. Încearcă din nou.");
  };
  recognition.onend = () => {
    if (voiceRecognition === recognition) voiceRecognition = null;
    updateVoiceChatButtons(false);
    if (!finalTranscript || recognitionError) return;
    if (targetId === "homePrompt") {
      el("prompt").value = target.value.trim(); target.value = ""; resizePrompt(); setView("chat");
    }
    speakNextAssistant = !looksLikeCvCreationRequest(el("prompt").value.trim());
    send();
  };
  try { recognition.start(); }
  catch { voiceRecognition = null; updateVoiceChatButtons(false); toast("Microfonul nu a putut fi pornit."); }
}
function iconFor(name) { return fileIcons[name.split(".").pop().toLowerCase()] || "·"; }
function storageKey(key) { return state.account?.role === "subscriber" ? `${key}-${state.account.id}` : key; }
function activeKey(project = state.project) { return storageKey(`nova-active-file-${project}`); }
function chatKey(project = state.project) { return storageKey(`nova-chat-${project}`); }

function updateAccountLabel() {
  const account = state.account;
  const subscriber = account.role === "subscriber";
  el("accountLabel").textContent = account.role === "subscriber"
    ? `${account.displayName || account.username} · ${account.quotaInterval === "month" ? "Standard" : "Gratuit"} · ${account.quotaRemaining}/${account.quotaLimit} unități AI ${account.quotaInterval === "month" ? "lunar" : "azi"}`
    : `${account.username} · Administrator`;
  const upgrade = el("subscriberUpgrade");
  if (upgrade) {
    upgrade.hidden = !subscriber;
    if (subscriber) {
      const paid = account.plan === "standard" || account.quotaInterval === "month";
      el("subscriberPlanLabel").textContent = paid ? "PLAN PRO ACTIV" : "PLAN GRATUIT";
      el("subscriberUpgradeTitle").textContent = paid ? "Abonamentul tău Pro" : "Upgrade Pro / Premium";
      el("subscriberUpgradeDescription").textContent = paid ? `${account.quotaRemaining}/${account.quotaLimit} unități AI disponibile în această perioadă.` : "Mai multe cereri AI și acces lunar.";
      el("subscriberUpgradeBtn").textContent = paid ? "Gestionează abonamentul" : "Upgrade acum";
    }
  }
  renderDashboardUsage();
}

async function loadAccount() {
  const account = await api("/api/auth/me"); state.account = account;
  const subscriber = account.role === "subscriber";
  const allowChanges = el("allowChanges");
  allowChanges.checked = !subscriber;
  allowChanges.disabled = !subscriber;
  el("allowChangesLabel").textContent = subscriber ? "Editează proiectul" : "Editare owner activă";
  el("allowChangesRow").title = subscriber
    ? "Permite-i agentului să creeze sau să modifice fișiere în proiectul selectat"
    : "Contul owner poate crea și modifica automat cod și scripturi în modul Construiește";
  el("providerSettingsBtn").hidden = subscriber;
  el("voiceSettingsBtn").hidden = subscriber;
  el("imageEditSettingsBtn").hidden = subscriber;
  el("editImageBtn").hidden = false;
  el("adminDashboardLink").hidden = subscriber;
  el("deleteAccountBtn").hidden = !subscriber;
  el("logoutBtn").hidden = !account.authEnabled;
  updateAccountLabel();
  el("accountAvatarLabel").textContent = account.username.slice(0, 1).toUpperCase();
}

function providerProfiles(settings = state.settings) {
  if (Array.isArray(settings?.providers)) return settings.providers.filter(provider => provider && typeof provider.id === "string");
  const id = settings?.platform || settings?.provider;
  if (!id) return [];
  const openAiCompatible = id === "openai";
  return [{
    id,
    name: settings.platformName || providerNames[id] || id,
    baseUrl: settings.baseUrl || "",
    textModel: settings.textModel || "",
    imageModel: settings.imageModel || "",
    speechModel: settings.speechModel || "",
    voice: settings.voice || "",
    apiKeyConfigured: settings.apiKeyConfigured === true,
    configured: settings.apiKeyConfigured === true || id === "ollama",
    capabilities: { text: true, image: openAiCompatible, imageEdit: openAiCompatible, speech: openAiCompatible }
  }];
}

function providerProfile(providerId, settings = state.settings) {
  return providerProfiles(settings).find(provider => provider.id === providerId);
}

function providerLabel(provider) {
  return providerNames[provider?.id] || provider?.name || provider?.id || "Motor AI";
}

function providerDisplayName(providerId, settings = state.settings) {
  const profile = providerProfile(providerId, settings);
  return profile ? providerLabel(profile) : providerNames[providerId] || providerId || "Motor AI";
}

function routeProfile(capability) {
  const routes = state.settings?.routes;
  const routeKey = capability === "imageEdit" ? "image" : capability;
  const providerId = routes && Object.prototype.hasOwnProperty.call(routes, routeKey)
    ? routes[routeKey]
    : state.settings?.platform || state.settings?.provider;
  return providerProfile(providerId);
}

function routeSupports(capability) {
  const profiles = providerProfiles();
  if (!profiles.length) return true;
  const profile = routeProfile(capability);
  if (!profile) return false;
  if (profile.ready && profile.ready[capability] === false) return false;
  if (!profile.ready && profile.configured === false) return false;
  if (!profile.capabilities) return true;
  return profile.capabilities[capability] === true;
}

function healthModels(data) {
  let models = data.models;
  if (models && !Array.isArray(models) && typeof models === "object") models = models.text || models.chat || models.available;
  if (!Array.isArray(models)) models = typeof models === "string" ? [models] : [];
  if (typeof data.model === "string") models.unshift(data.model);
  if (typeof data.recommendedModel === "string") models.unshift(data.recommendedModel);
  const configuredModel = routeProfile("text")?.textModel;
  if (configuredModel) models.unshift(configuredModel);
  return [...new Set(models.map(model => typeof model === "string" ? model : model?.id || model?.name || "").filter(Boolean).map(model => String(model).trim()).filter(Boolean))];
}

function fallbackNames(fallbacks) {
  const entries = Array.isArray(fallbacks) ? fallbacks : fallbacks && typeof fallbacks === "object" ? Object.values(fallbacks).flat() : [];
  return entries.map(fallback => {
    if (typeof fallback === "string") return providerDisplayName(fallback);
    const providerId = fallback?.provider || fallback?.providerId;
    return fallback?.providerName || fallback?.name || (providerId ? providerDisplayName(providerId) : "") || fallback?.model;
  }).filter(Boolean);
}

async function refreshHealth() {
  const badge = el("statusBadge"), dot = el("connectionDot"), label = el("connectionText"), select = el("modelSelect");
  const sideDot = el("sidebarConnectionDot"), sideLabel = el("sidebarConnectionText");
  el("instanceBadge").textContent = "ONLINE · CLOUD";
  el("projectStorageLabel").textContent = "Fișiere pe serverul cloud";
  try {
    const data = await api("/api/health");
    const providerName = data.providerName || (data.provider ? providerDisplayName(data.provider) : state.settings?.platformName) || "Motor AI";
    if (!data.connected) {
      const message = data.error || `Conexiunea cu ${providerName} nu este disponibilă`;
      label.title = message;
      sideLabel.title = message;
      throw new Error(message);
    }
    const fallbacks = fallbackNames(data.fallbacks);
    const connectionTitle = fallbacks.length ? `Motoare de rezervă: ${fallbacks.join(", ")}` : `${providerName} este conectat`;
    label.title = connectionTitle; sideLabel.title = connectionTitle; badge.title = connectionTitle;
    dot.classList.add("on"); label.textContent = `${providerName} conectat`;
    sideDot.classList.add("on"); sideLabel.textContent = `${providerName} conectat`;
    badge.textContent = `${providerName} · verificat`;
    badge.style.color = "var(--mint)"; badge.style.borderColor = "#364b40";
    const previous = select.value; select.replaceChildren();
    const models = healthModels(data);
    if (!models.length) select.add(new Option(`Setează modelul pentru ${providerName}`, ""));
    else {
      models.forEach(model => select.add(new Option(model, model)));
      const configured = routeProfile("text")?.textModel;
      const recommended = typeof data.recommendedModel === "string" ? data.recommendedModel : "";
      select.value = models.includes(previous) ? previous : models.includes(recommended) ? recommended : models.includes(configured) ? configured : models[0];
    }
  } catch (error) {
    dot.classList.remove("on"); label.textContent = "Motor AI neconectat"; badge.textContent = "AI neconectat";
    sideDot.classList.remove("on");
    const reason = error?.message || "Verifică profilurile și rutele din Motoare AI.";
    sideLabel.textContent = reason;
    label.title = reason; sideLabel.title = reason; badge.title = reason;
    badge.style.color = "#e4a69b"; badge.style.borderColor = "#583b35";
    const configured = routeProfile("text")?.textModel;
    select.replaceChildren(new Option(configured || "Configurează un motor AI", configured || ""));
  }
}

function updateCapabilityControls() {
  const controls = [
    ["generateImageBtn", "image", "Configurează o rută de imagini în Motoare AI."],
    ["editImageBtn", "imageEdit", "Configurează un motor compatibil cu editarea imaginilor."],
    ["voiceComposerBtn", "speech", "Configurează o rută vocală în Motoare AI."],
    ["homeVoiceBtn", "speech", "Configurează o rută vocală în Motoare AI."]
  ];
  controls.forEach(([id, capability, unavailableTitle]) => {
    const button = el(id);
    if (!button) return;
    const available = routeSupports(capability);
    button.disabled = !available;
    if (!available) button.title = unavailableTitle;
  });
}

function renderProviderOptions(settings) {
  const select = el("providerSelect"), profiles = providerProfiles(settings);
  select.replaceChildren();
  profiles.forEach(provider => select.add(new Option(providerLabel(provider), provider.id)));
  if (!profiles.length) select.add(new Option("Niciun profil disponibil", ""));
}

function renderProviderProfile(providerId) {
  const profile = providerProfile(providerId) || providerProfiles()[0];
  if (!profile) return;
  el("providerSelect").value = profile.id;
  editingProviderId = profile.id;
  el("apiBaseUrl").value = profile.baseUrl || "";
  el("apiBaseUrl").readOnly = !["custom", "ollama"].includes(profile.id);
  el("textModel").value = profile.textModel || "";
  el("imageModel").value = profile.imageModel || "";
  el("speechModel").value = profile.speechModel || "";
  el("voiceSelect").value = profile.voice || "";
  el("apiKey").value = "";
  el("apiKey").placeholder = profile.apiKeyConfigured
    ? "•••••••• · lasă gol pentru a păstra cheia"
    : "Introdu cheia sau lasă gol dacă nu este necesară";
  el("clearApiKey").checked = false;
  el("clearApiKey").disabled = !profile.apiKeyConfigured;
  el("apiKeyState").textContent = profile.apiKeyConfigured
    ? "•••••••• · Cheie configurată pe server. Valoarea nu este returnată în browser."
    : "Nicio cheie salvată pentru acest profil. Valoarea introdusă este trimisă numai la salvare.";
  el("providerProfileState").textContent = `${profile.configured ? "Configurat" : "Neconfigurat"} · ${providerLabel(profile)}`;
  const capabilities = profile.capabilities || {};
  const capabilityList = el("providerCapabilities"); capabilityList.replaceChildren();
  [["text", "Text"], ["image", "Imagini"], ["imageEdit", "Editare imagini"], ["speech", "Voce"]].forEach(([id, label]) => {
    const chip = document.createElement("span"); chip.className = `capability-chip${capabilities[id] ? " on" : ""}`;
    chip.textContent = `${capabilities[id] ? "✓" : "—"} ${label}`; capabilityList.append(chip);
  });
  const capabilitiesKnown = Object.keys(capabilities).length > 0;
  el("textModel").disabled = capabilitiesKnown && capabilities.text !== true;
  el("imageModel").disabled = capabilitiesKnown && capabilities.image !== true && capabilities.imageEdit !== true;
  el("speechModel").disabled = capabilitiesKnown && capabilities.speech !== true;
  el("voiceSelect").disabled = capabilitiesKnown && capabilities.speech !== true;
  providerDraftDirty = false;
}

function renderRouteOptions(selectId, capability, selectedProviderId) {
  const select = el(selectId), profiles = providerProfiles();
  const capable = profiles.filter(provider => {
    if (!provider.capabilities || !Object.keys(provider.capabilities).length) return true;
    return provider.capabilities[capability] === true;
  });
  select.replaceChildren();
  capable.forEach(provider => select.add(new Option(`${providerLabel(provider)}${provider.configured ? "" : " · neconfigurat"}`, provider.id)));
  if (!capable.length) select.add(new Option("Nicio rută disponibilă", ""));
  if (capable.some(provider => provider.id === selectedProviderId)) select.value = selectedProviderId;
}

function renderRoutes(settings) {
  const routes = settings.routes || {};
  renderRouteOptions("routeText", "text", routes.text || settings.platform);
  renderRouteOptions("routeImage", "image", routes.image);
  renderRouteOptions("routeSpeech", "speech", routes.speech);
  el("autoSelectProvider").checked = routes.autoSelect !== false;
  el("autoFallback").checked = routes.autoFallback === true;
}

function searchProfiles(settings = state.settings) {
  const profiles = settings?.search?.providers;
  return Array.isArray(profiles) && profiles.length ? profiles : defaultSearchProviders;
}

function renderSearchProfile(providerId) {
  const profile = searchProfiles().find(provider => provider.id === providerId) || searchProfiles()[0];
  if (!profile) return;
  el("searchProvider").value = profile.id;
  editingSearchProvider = profile.id;
  el("searchApiKey").value = "";
  el("clearSearchApiKey").checked = false;
  const requiresKey = profile.requiresKey !== false;
  el("searchApiKey").disabled = !requiresKey;
  el("clearSearchApiKey").disabled = !requiresKey || !profile.keyConfigured;
  el("searchApiKey").placeholder = profile.keyConfigured
    ? "•••••••• · lasă gol pentru a păstra cheia"
    : requiresKey ? `Introdu cheia pentru ${profile.name || profile.id}` : "Nu este necesară o cheie";
  el("searchKeyState").textContent = !requiresKey
    ? `${profile.name || profile.id} nu necesită o cheie proprie.`
    : profile.keyConfigured
      ? "•••••••• · Cheie configurată pe server. Valoarea nu este returnată în browser."
      : `Nicio cheie salvată pentru ${profile.name || profile.id}.`;
  searchDraftDirty = false;
}

function renderSearchSettings(settings) {
  const select = el("searchProvider"), profiles = searchProfiles(settings);
  select.replaceChildren(); profiles.forEach(provider => select.add(new Option(provider.name || provider.id, provider.id)));
  const selected = profiles.some(provider => provider.id === settings.search?.provider) ? settings.search.provider : profiles[0]?.id;
  if (selected) renderSearchProfile(selected);
}

async function loadProviderSettings() {
  const { settings } = await api("/api/settings"); state.settings = settings;
  renderProviderOptions(settings);
  renderRoutes(settings);
  renderSearchSettings(settings);
  renderProviderProfile(settings.platform || settings.provider || providerProfiles(settings)[0]?.id);
  renderDashboardProviders();
  updateCapabilityControls();
  await refreshHealth();
}

async function testWebConnection() {
  const button = el("testWebConnection"), status = el("webConnectionStatus");
  if (searchDraftDirty || el("searchProvider").value !== state.settings?.search?.provider) {
    status.textContent = "Salvează mai întâi motorul și cheia de căutare, apoi verifică accesul.";
    return;
  }
  button.disabled = true;
  status.textContent = "Se verifică o căutare reală pe internet…";
  try {
    const data = await api("/api/web/health");
    status.textContent = data.connected
      ? `Internet verificat: căutarea a returnat ${data.sourceCount} surse. Versiune server: ${data.version}.`
      : `Acces web neconfirmat: ${data.error || "Căutarea a eșuat."} Versiune server: ${data.version}.`;
  } catch (error) { status.textContent = `Verificarea accesului web a eșuat: ${error.message}`; }
  finally { button.disabled = false; }
}

async function saveProviderSettings() {
  const settings = {
    providerId: el("providerSelect").value,
    baseUrl: el("apiBaseUrl").value.trim(),
    apiKey: el("apiKey").value,
    clearApiKey: el("clearApiKey").checked,
    textModel: el("textModel").value.trim(),
    imageModel: el("imageModel").value.trim(),
    speechModel: el("speechModel").value.trim(),
    voice: el("voiceSelect").value.trim(),
    routes: {
      text: el("routeText").value,
      image: el("routeImage").value,
      speech: el("routeSpeech").value,
      autoSelect: el("autoSelectProvider").checked,
      autoFallback: el("autoFallback").checked
    },
    search: {
      provider: el("searchProvider").value,
      apiKey: el("searchApiKey").value,
      clearApiKey: el("clearSearchApiKey").checked
    }
  };
  const result = await api("/api/settings", jsonBody(settings));
  state.settings = result.settings; el("apiKey").value = ""; el("searchApiKey").value = "";
  providerDraftDirty = false; searchDraftDirty = false;
  el("providerDialog").close(); await refreshHealth();
  renderDashboardProviders();
  updateCapabilityControls();
  toast(result.notice || "Motoarele AI și rutele au fost salvate");
}

function providerMonogram(profile) {
  const labels = { openai: "AI", gemini: "G", anthropic: "C", openrouter: "OR", groq: "GQ", mistral: "M", deepseek: "DS", xai: "X", together: "T", custom: "API", ollama: "O" };
  return labels[profile?.id] || String(profile?.name || "AI").slice(0, 2).toUpperCase();
}

function renderDashboardProviders() {
  const rail = el("providerRail"), tabs = el("dashboardModelTabs");
  if (!rail || !tabs) return;
  rail.replaceChildren(); tabs.replaceChildren();
  const profiles = providerProfiles();
  const activeId = state.settings?.platform || state.settings?.routes?.text;
  profiles.slice(0, 9).forEach(profile => {
    const ready = profile.ready?.text ?? profile.configured === true;
    const row = document.createElement("div"); row.className = "rail-provider";
    const icon = document.createElement("span"); icon.className = "rail-provider-icon"; icon.textContent = providerMonogram(profile);
    const copy = document.createElement("span"); copy.className = "rail-provider-copy";
    const name = document.createElement("strong"); name.textContent = providerLabel(profile);
    const model = document.createElement("small"); model.textContent = profile.textModel || "Model neconfigurat";
    const status = document.createElement("span"); status.className = `rail-provider-state${ready ? "" : " off"}`; status.textContent = ready ? "Activ" : "Cheie";
    copy.append(name, model); row.append(icon, copy, status); rail.append(row);
    if (ready) {
      const tab = document.createElement("span"); tab.className = `model-tab${profile.id === activeId ? " active" : ""}`;
      tab.textContent = providerLabel(profile); tabs.append(tab);
    }
  });
  if (!rail.children.length) { const empty = document.createElement("div"); empty.className = "rail-empty"; empty.textContent = "Niciun motor AI disponibil."; rail.append(empty); }
  if (!tabs.children.length) { const tab = document.createElement("span"); tab.className = "model-tab active"; tab.textContent = "Configurează un motor"; tabs.append(tab); }
  renderDashboardUsage();
}

function renderDashboardProjects() {
  const rail = el("railProjects");
  if (!rail) return;
  rail.replaceChildren();
  state.projects.slice(0, 6).forEach(project => {
    const item = document.createElement("button"); item.type = "button"; item.className = "rail-project"; item.textContent = project.name;
    item.addEventListener("click", async () => {
      try { if (project.id !== state.project) await loadProject(project.id); setView("chat"); if (!el("app").classList.contains("workspace-open")) el("openWorkspaceBtn").click(); }
      catch (error) { toast(error.message); }
    });
    rail.append(item);
  });
  if (!rail.children.length) { const empty = document.createElement("div"); empty.className = "rail-empty"; empty.textContent = "Creează primul proiect pentru a-l vedea aici."; rail.append(empty); }
}

function renderDashboardUsage() {
  const node = el("railUsage");
  if (!node) return;
  node.replaceChildren();
  const account = state.account;
  const configured = providerProfiles().filter(profile => profile.ready?.text ?? profile.configured === true).length;
  const limit = Number(account?.quotaLimit || 0), remaining = Number(account?.quotaRemaining || 0);
  const requestPercent = account?.role === "subscriber" && limit ? Math.max(0, Math.min(100, Math.round((limit - remaining) / limit * 100))) : configured ? 100 : 0;
  const rows = [
    ["Motoare", configured ? 100 : 0, configured ? String(configured) : "0"],
    ["Cereri AI", requestPercent, account?.role === "subscriber" && limit ? `${limit - remaining}/${limit}` : "Auto"],
    ["Proiecte", Math.min(100, state.projects.length * 10), String(state.projects.length)]
  ];
  rows.forEach(([label, percent, value]) => {
    const row = document.createElement("div"); row.className = "usage-row";
    const name = document.createElement("span"); name.textContent = label;
    const track = document.createElement("span"); track.className = "usage-track";
    const fill = document.createElement("span"); fill.className = "usage-fill"; fill.style.width = `${percent}%`; track.append(fill);
    const amount = document.createElement("span"); amount.textContent = value; row.append(name, track, amount); node.append(row);
  });
}

function renderProjects() {
  const select = el("projectSelect"); select.replaceChildren();
  for (const project of state.projects) select.add(new Option(project.name, project.id));
  if (state.project) select.value = state.project;
  const current = state.projects.find(project => project.id === state.project);
  el("projectName").textContent = current?.name || "Niciun proiect";
  renderHomeProjects();
  renderDashboardProjects();
  renderDashboardUsage();
}

function renderHomeProjects() {
  const list = el("homeProjects");
  if (!list) return;
  list.replaceChildren();
  const projects = state.projects.slice(0, 4);
  projects.forEach((project, index) => {
    const card = document.createElement("button"); card.className = `home-project-card project-tone-${index % 5}`; card.type = "button";
    card.dataset.projectId = project.id;
    card.setAttribute("aria-label", `Deschide proiectul ${project.name}`);
    const cover = document.createElement("span"); cover.className = `project-cover cover-${index % 5}`; cover.setAttribute("aria-hidden", "true");
    const scene = document.createElement("span"); scene.className = "cover-scene";
    const glow = document.createElement("span"); glow.className = "cover-glow";
    const detailLines = document.createElement("span"); detailLines.className = "cover-detail";
    cover.append(glow, scene, detailLines);
    const name = document.createElement("strong"); name.className = "project-name"; name.textContent = project.name;
    const detail = document.createElement("small"); detail.className = "project-description";
    const fileCount = project.id === state.project ? state.files.length : Number.isInteger(project.fileCount) ? project.fileCount : null;
    const countLabel = fileCount === 1 ? "1 fișier" : fileCount === 0 ? "Proiect gol" : fileCount === null ? "Proiect" : `${fileCount} fișiere`;
    detail.textContent = project.id === state.project ? `${countLabel} · Activ` : `${countLabel} · Deschide`;
    card.append(cover, name, detail); list.append(card);
  });
  const index = projects.length;
  const card = document.createElement("button"); card.type = "button";
  card.className = `home-project-card project-create-card project-tone-${index % 5}`;
  card.dataset.createProject = ""; card.setAttribute("aria-label", "Creează un proiect nou");
  const cover = document.createElement("span"); cover.className = `project-cover cover-${index % 5}`; cover.setAttribute("aria-hidden", "true");
  const scene = document.createElement("span"); scene.className = "cover-scene";
  const glow = document.createElement("span"); glow.className = "cover-glow";
  const detailLines = document.createElement("span"); detailLines.className = "cover-detail";
  const plus = document.createElement("span"); plus.className = "project-create-plus"; plus.setAttribute("aria-hidden", "true"); plus.textContent = "+";
  cover.append(glow, scene, detailLines, plus);
  const name = document.createElement("strong"); name.className = "project-name"; name.textContent = "Proiect nou";
  const detail = document.createElement("small"); detail.className = "project-description"; detail.textContent = "Alege numele și începe";
  card.append(cover, name, detail); list.append(card);
}

function updateHomeHistory() {
  const section = el("homeHistory");
  if (!section) return;
  const lastUser = [...state.chat].reverse().find(message => message.role === "user");
  section.hidden = !lastUser;
  if (lastUser) {
    const preview = lastUser.displayContent || String(lastUser.content || "").split(/\n\nProiect:\s/)[0];
    el("resumeChatPreview").textContent = preview.slice(0, 120) || "Redeschide conversația salvată în acest proiect.";
  }
}

function setSidebarActive(target) {
  document.querySelectorAll(".create-menu .create-item").forEach(button => {
    const active = button === target;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
}

function setView(view) {
  state.view = view === "chat" ? "chat" : "home";
  if (state.view === "home" && el("prompt").value.trim() && !el("homePrompt").value.trim()) el("homePrompt").value = el("prompt").value;
  el("chat").classList.toggle("home-active", state.view === "home");
  if (state.view === "chat") setWorkspaceOpen(false);
  setProjectsOpen(false);
  const selectedTask = el("taskSelect").value;
  const activeButton = state.view === "home"
    ? document.querySelector('.create-item[data-view="home"]')
    : document.querySelector(selectedTask === "auto" ? '.create-item[data-view="chat"]' : `.create-item[data-task="${selectedTask}"]`);
  setSidebarActive(activeButton);
  updateHomeHistory();
}

function setProjectsOpen(open) {
  const app = el("app"), drawer = el("projectDrawer"), button = el("projectsNavBtn");
  app?.classList.toggle("projects-open", open);
  if (drawer) drawer.open = open;
  if (button) button.setAttribute("aria-expanded", String(open));
  if (open) setSidebarActive(button);
  else {
    const task = el("taskSelect")?.value || "auto";
    setSidebarActive(state.view === "home"
      ? document.querySelector('.create-item[data-view="home"]')
      : document.querySelector(task === "auto" ? '.create-item[data-view="chat"]' : `.create-item[data-task="${task}"]`));
  }
}

function renderFiles() {
  const list = el("fileList"); list.replaceChildren();
  const files = state.files.filter(file => file.path.toLowerCase().includes(state.filter.toLowerCase()));
  if (!files.length) { const empty = document.createElement("div"); empty.className = "project-path"; empty.style.padding = "8px 10px"; empty.textContent = state.filter ? "Niciun rezultat" : "Proiect gol"; list.append(empty); return; }
  for (const file of files) {
    const button = document.createElement("button"); button.className = `file${file.path === state.activePath ? " active" : ""}`;
    const icon = document.createElement("span"); icon.className = "file-icon"; icon.textContent = iconFor(file.path);
    const label = document.createElement("span"); label.textContent = file.path;
    button.append(icon, label); button.addEventListener("click", () => openFile(file.path)); list.append(button);
  }
}

function updateLines() {
  const lines = el("editor").value.split("\n").length;
  el("lineCount").textContent = lines;
  el("gutter").textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
}

function renderChat() {
  const box = el("messages");
  box.replaceChildren();
  activeMessageStream = document.createElement("div");
  activeMessageStream.className = "message-stream";
  box.append(activeMessageStream);
  for (const message of state.chat) {
    const visibleContent = message.role === "user"
      ? (message.displayContent || String(message.content || "").split(/\n\nProiect:\s/)[0])
      : message.content;
    addBubble(message.role, visibleContent, message.events);
  }
  box.scrollTop = box.scrollHeight;
  updateHomeHistory();
}

function messageContainer() {
  if (!activeMessageStream) {
    activeMessageStream = document.createElement("div"); activeMessageStream.className = "message-stream";
    el("messages").replaceChildren(activeMessageStream);
  }
  return activeMessageStream;
}

function setTask(task) {
  const supported = ["auto", "image", "code", "text", "lyrics", "business"];
  const selected = supported.includes(task) ? task : "auto";
  el("taskSelect").value = selected;
  document.querySelectorAll(".mode-chip[data-task]").forEach(button => button.classList.toggle("active", button.dataset.task === selected));
  if (state.view === "chat") setSidebarActive(document.querySelector(selected === "auto" ? '.create-item[data-view="chat"]' : `.create-item[data-task="${selected}"]`));
  const prompts = {
    auto: "Descrie ce vrei să creezi… (Enter trimite, Shift+Enter pentru rând nou)",
    image: "Descrie imaginea pe care vrei s-o creezi…",
    code: "Descrie aplicația sau unealta pe care vrei să o construiești…",
    text: "Ce text dorești? Spune publicul, scopul, tonul și lungimea…",
    lyrics: "Descrie tema, genul și emoția versurilor: strofe, refren și punte…",
    business: "Descrie ideea de afacere; Nova va crea site-ul funcțional și îl va publica online…"
  };
  el("prompt").placeholder = prompts[selected];
  el("generateImageBtn").classList.toggle("active", selected === "image");
  if (selected === "business") {
    el("modeSelect").value = "build";
    el("allowChanges").checked = true;
  }
}

function resizePrompt() {
  const prompt = el("prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 190)}px`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function safeMediaName(title, extension) {
  const stem = title.normalize("NFKD").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-").slice(0, 48) || "nova-media";
  return `${stem}.${extension}`;
}

function safeImageResultUrl(value) {
  if (typeof value !== "string" || value.length > 34 * 1024 * 1024) throw new Error("Furnizorul a returnat o imagine invalidă.");
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value)) return value;
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Furnizorul a returnat o adresă de imagine invalidă."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Imaginea furnizorului trebuie livrată prin HTTPS.");
  return url.href;
}

function selectedSpeechOptions() {
  const voice = el("speechVoice").value;
  return { ...(voice ? { voice } : {}), speed: Number(el("speechSpeed").value) };
}

async function generateSpeech(text, options = {}) {
  const input = text.trim();
  if (input.length > 4096) throw new Error("Vocea acceptă cel mult 4096 de caractere. Împarte textul în fragmente pentru a-l asculta integral.");
  return api("/api/media/speech", jsonBody({ ...options, text: input }));
}

function updateVoiceCost() {
  const units = Math.ceil(el("voiceText").value.trim().length / 500);
  el("voiceCost").textContent = state.account?.role === "subscriber"
    ? `Voce rostită, nu cântată. Consum: ${units} ${units === 1 ? "unitate AI" : "unități AI"} din cota disponibilă. Maximum 4096 de caractere.`
    : "Voce rostită, nu cântată. Maximum 4096 de caractere; generarea este tarifată de furnizorul AI.";
}

function openVoiceDialog() {
  const dialog = el("voiceDialog"), voiceText = el("voiceText"), status = el("voiceStatus");
  if (!voiceText.value.trim() && el("prompt").value.trim()) voiceText.value = el("prompt").value.trim();
  const configuredVoice = routeProfile("speech")?.voice;
  el("speechVoice").placeholder = configuredVoice ? `Vocea configurată: ${configuredVoice}` : "Vocea configurată";
  status.hidden = true; status.textContent = ""; status.classList.remove("error");
  updateVoiceCost(); setSidebarActive(el("sideVoiceBtn")); dialog.showModal(); voiceText.focus();
}

function mediaMetadata(label, result, capability) {
  const profile = routeProfile(capability);
  const providerName = result.providerName || (result.provider ? providerDisplayName(result.provider) : profile ? providerLabel(profile) : "");
  return [label, providerName, result.model].filter(Boolean).join(" · ");
}

function addVoiceCard(text, result) {
  const node = document.createElement("div"); node.className = "message assistant";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = mediaMetadata("Voce AI", result, "speech");
  const transcript = document.createElement("div"); transcript.textContent = text;
  const output = document.createElement("div"); output.className = "creative-output";
  const player = document.createElement("audio"); player.controls = true; player.src = result.dataUrl;
  const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă voice-over MP3"; link.href = result.dataUrl; link.download = "nova-voice-over.mp3";
  output.append(player, link); node.append(meta, transcript, output);
  messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
}

async function generateVoiceFromDialog() {
  const text = el("voiceText").value.trim(), status = el("voiceStatus"), button = el("generateVoiceBtn");
  status.hidden = false; status.classList.remove("error");
  if (!text) { status.textContent = "Scrie textul pentru voice-over."; el("voiceText").focus(); return; }
  button.disabled = true; button.textContent = "Se generează MP3…"; status.textContent = "Trimit textul către furnizorul vocal configurat…";
  try {
    const result = await generateSpeech(text, selectedSpeechOptions());
    setView("chat");
    addBubble("user", `Creează un voice-over MP3: ${text}`);
    addVoiceCard(text, result);
    el("voiceDialog").close(); el("voiceText").value = ""; status.hidden = true;
  } catch (error) {
    status.classList.add("error"); status.textContent = error.message || "Generarea voice-over-ului a eșuat.";
  } finally { button.disabled = false; button.textContent = "Generează MP3"; }
}

function addSpeechButton(node, text, label = "Ascultă cu voce AI") {
  if (state.account?.role === "subscriber") label += ` (${Math.ceil(text.trim().length / 500)} unități AI)`;
  const button = document.createElement("button"); button.className = "btn small"; button.textContent = label;
  const output = document.createElement("div"); output.className = "creative-output";
  button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "Se generează vocea…";
    try {
      const speech = await generateSpeech(text, selectedSpeechOptions()), player = document.createElement("audio"); player.controls = true; player.src = speech.dataUrl;
      const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă voice-over MP3"; link.href = speech.dataUrl; link.download = "nova-voice-over.mp3";
      output.replaceChildren(player, link); button.textContent = "Generează din nou";
    } catch (error) { toast(error.message); button.textContent = label; }
    finally { button.disabled = false; }
  });
  node.append(button, output);
}

function addImageCard(prompt, result) {
  const source = safeImageResultUrl(result.dataUrl);
  const node = document.createElement("div"); node.className = "message assistant";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = mediaMetadata(result.edited ? "Imagine modificată" : "Imagine AI", result, "image");
  const caption = document.createElement("div"); caption.textContent = prompt;
  const img = document.createElement("img"); img.className = "creative-image"; img.alt = prompt; img.referrerPolicy = "no-referrer"; img.src = source;
  const link = document.createElement("a"); link.className = "btn small"; link.textContent = `Descarcă ${(result.format || "png").toUpperCase()}`; link.href = source; link.referrerPolicy = "no-referrer"; link.rel = "noopener noreferrer"; link.download = safeMediaName(prompt.slice(0, 48), result.format || "png");
  node.append(meta, caption, img, link); messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
}

async function generateImageFromPrompt() {
  if (el("generateImageBtn").disabled) return;
  const prompt = el("prompt").value.trim(); if (!prompt) { toast("Descrie imaginea în caseta de chat."); return; }
  setView("chat");
  const button = el("generateImageBtn"); button.disabled = true;
  addBubble("user", `Creează imagine: ${prompt}`);
  const pending = document.createElement("div"); pending.className = "thinking"; pending.textContent = "Se generează imaginea…"; messageContainer().append(pending);
  el("prompt").value = "";
  try { const result = await api("/api/media/image", jsonBody({ prompt })); addImageCard(prompt, result); }
  catch (error) { if (!el("prompt").value.trim()) { el("prompt").value = prompt; resizePrompt(); } addBubble("assistant", error.message); }
  finally { pending.remove(); button.disabled = false; }
}

let imageEditPreviewUrl = "";

function selectedImageEditFile() {
  const file = el("imageEditFile").files?.[0];
  if (!file) throw new Error("Alege fotografia pe care vrei să o modifici.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Fotografia trebuie să fie PNG, JPG sau WebP.");
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error("Fotografia poate avea cel mult 8 MiB.");
  return file;
}

function showImageEditPreview() {
  const preview = el("imageEditPreview"), status = el("imageEditStatus");
  try {
    const file = selectedImageEditFile();
    if (imageEditPreviewUrl) URL.revokeObjectURL(imageEditPreviewUrl);
    imageEditPreviewUrl = URL.createObjectURL(file); preview.src = imageEditPreviewUrl; preview.hidden = false;
    status.hidden = true; status.textContent = "";
  } catch (error) {
    preview.hidden = true; preview.removeAttribute("src");
    status.hidden = false; status.classList.add("error"); status.textContent = error.message;
  }
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Fotografia nu a putut fi citită."));
    reader.readAsDataURL(file);
  });
}

function openImageEditDialog() {
  const draft = el("prompt").value.trim();
  if (draft && !el("imageEditPrompt").value.trim()) el("imageEditPrompt").value = draft;
  el("imageEditStatus").hidden = true;
  el("imageEditDialog").showModal();
}

async function generateImageEdit() {
  const status = el("imageEditStatus"), button = el("generateImageEditBtn");
  try {
    const file = selectedImageEditFile(), prompt = el("imageEditPrompt").value.trim();
    if (!prompt) { el("imageEditPrompt").focus(); throw new Error("Descrie schimbarea pe care o dorești în fotografie."); }
    button.disabled = true; status.hidden = false; status.classList.remove("error"); status.textContent = "Se încarcă fotografia și se generează modificarea…";
    const result = await api("/api/media/image/edit", jsonBody({ prompt, image: await fileDataUrl(file) }));
    setView("chat"); addBubble("user", `Modifică fotografia: ${prompt}`); addImageCard(prompt, result);
    el("imageEditDialog").close(); el("imageEditFile").value = ""; el("imageEditPrompt").value = "";
    el("imageEditPreview").hidden = true; el("imageEditPreview").removeAttribute("src");
    if (imageEditPreviewUrl) URL.revokeObjectURL(imageEditPreviewUrl); imageEditPreviewUrl = "";
  } catch (error) {
    status.hidden = false; status.classList.add("error"); status.textContent = error.message || "Modificarea imaginii a eșuat.";
  } finally { button.disabled = false; }
}

function addBubble(role, content, events = [], metadata = null) {
  const messageText = typeof content === "string" ? content : String(content ?? "");
  const node = document.createElement("div"); node.className = `message ${role}`;
  const meta = document.createElement("div"); meta.className = "message-meta";
  const provider = metadata?.providerName || (metadata?.provider ? providerDisplayName(metadata.provider) : "");
  meta.textContent = role === "user" ? "Tu" : ["Nova", provider, metadata?.model].filter(Boolean).join(" · ");
  const body = document.createElement("div"); body.textContent = messageText;
  node.append(meta, body);
  if (role === "assistant" && messageText.trim()) {
    const download = document.createElement("button"); download.className = "btn small"; download.textContent = "Descarcă TXT";
    download.addEventListener("click", () => downloadBlob(new Blob([messageText], { type: "text/plain;charset=utf-8" }), safeMediaName(messageText.split("\n")[0].slice(0, 70) || "Nova", "txt")));
    node.append(download);
  }
  if (events?.length) {
    const activity = document.createElement("div"); activity.className = "agent-events";
    activity.textContent = events.map(event => `${event.ok ? "✓" : "!"} ${event.summary}`).join("\n"); node.append(activity);
  }
  if (role === "assistant" && messageText.trim() && routeSupports("speech")) {
    const row = document.createElement("div"); row.className = "apply-row"; addSpeechButton(row, messageText); node.append(row);
  }
  messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
  if (role === "assistant" && messageText.trim() && speakNextAssistant) {
    speakNextAssistant = false;
    speakChatReply(messageText);
  }
}

async function saveFile(showToast = false) {
  if (!state.project || !state.activePath) return;
  await api("/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.project, path: state.activePath, content: el("editor").value }) });
  state.dirty = false; el("dirtyMark").hidden = true;
  await refreshFiles(false);
  if (showToast) toast("Fișier salvat pe disc");
}

async function refreshFiles(keepActive = true) {
  if (!state.project) return;
  const data = await api(`/api/files?project=${encodeURIComponent(state.project)}`);
  state.files = data.files;
  if (!state.files.some(file => file.path === state.activePath)) {
    state.activePath = state.files.find(file => /\.(js|ts|py|gpc|html|css)$/i.test(file.path))?.path || state.files[0]?.path || null;
  }
  renderFiles();
  if (keepActive && state.activePath) await openFile(state.activePath, true);
}

async function openFile(name, force = false) {
  if (!force && state.dirty) {
    if (confirm("Fișierul are modificări nesalvate. Le salvez înainte să deschid altul? Apasă Cancel ca să rămâi aici.")) await saveFile(false);
    else return;
  }
  const data = await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(name)}`);
  state.activePath = name; localStorage.setItem(activeKey(), name);
  el("activeFileName").textContent = name; el("editor").value = data.content;
  const ext = name.split(".").pop().toLowerCase();
  el("languageLabel").textContent = ({ js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", py: "Python", md: "Markdown", css: "CSS", html: "HTML", json: "JSON", gpc: "GPC" })[ext] || ext.toUpperCase();
  state.dirty = false; el("dirtyMark").hidden = true; renderFiles(); updateLines();
}

async function loadProject(id) {
  if (state.dirty && state.project) await saveFile(false);
  state.project = id; renderProjects();
  try { state.chat = JSON.parse(localStorage.getItem(chatKey()) || "[]"); } catch { state.chat = []; }
  renderChat();
  const savedActive = localStorage.getItem(activeKey());
  const data = await api(`/api/files?project=${encodeURIComponent(id)}`); state.files = data.files;
  state.activePath = state.files.some(file => file.path === savedActive) ? savedActive : (state.files.find(file => /\.(js|ts|py|gpc|html|css)$/i.test(file.path))?.path || state.files[0]?.path || null);
  renderFiles(); renderHomeProjects();
  if (state.activePath) await openFile(state.activePath, true);
  await refreshPublication();
}

async function loadProjects() {
  const data = await api("/api/projects"); state.projects = data.projects;
  if (!state.projects.length) {
    const created = await api("/api/projects", jsonBody({ name: "Nova Playground" }));
    state.projects = [created.project];
  }
  const remembered = localStorage.getItem(storageKey("nova-project"));
  const selected = state.projects.find(project => project.id === remembered) || state.projects[0];
  state.project = selected.id; localStorage.setItem(storageKey("nova-project"), selected.id); renderProjects(); await loadProject(selected.id);
}

function createProject(name = "") {
  const dialog = el("newProjectDialog");
  el("newProjectName").value = name;
  dialog.showModal();
  requestAnimationFrame(() => el("newProjectName").focus());
}

async function saveNewProject(name) {
  if (!name?.trim()) return;
  try {
    const data = await api("/api/projects", jsonBody({ name: name.trim() }));
    state.projects.push(data.project); state.dirty = false; await loadProject(data.project.id); localStorage.setItem(storageKey("nova-project"), data.project.id); setProjectsOpen(false); toast("Proiect creat"); return true;
  } catch (error) { toast(error.message); return false; }
}

function looksLikeCvCreationRequest(value) {
  const text = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /\b(cv|curriculum vitae|resume)\b/.test(text) && /\b(cree|crea|fac|generez|trimit|public|online)/.test(text);
}

function openCvBuilder() {
  const dialog = el("cvDialog"), form = el("cvForm");
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey("nova-cv-draft")) || "null");
    if (draft?.requestId && draft.payload) {
      form.dataset.requestId = draft.requestId;
      for (const field of ["Name", "Role", "Email", "Phone", "Location", "Summary", "Experience", "Education", "Skills", "Links"]) {
        const key = field.toLowerCase();
        if (typeof draft.payload[key] === "string") el(`cv${field}`).value = draft.payload[key];
      }
    }
  } catch { sessionStorage.removeItem(storageKey("nova-cv-draft")); }
  el("cvStatus").hidden = true; setSidebarActive(el("openCvBuilderBtn"));
  dialog.showModal();
  requestAnimationFrame(() => el("cvName").focus());
}

function newCvRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createCvOnline() {
  const form = el("cvForm"), button = el("createCvBtn"), status = el("cvStatus");
  form.dataset.requestId ||= newCvRequestId();
  const payload = {
    requestId: form.dataset.requestId,
    name: el("cvName").value,
    role: el("cvRole").value,
    email: el("cvEmail").value,
    phone: el("cvPhone").value,
    location: el("cvLocation").value,
    summary: el("cvSummary").value,
    experience: el("cvExperience").value,
    education: el("cvEducation").value,
    skills: el("cvSkills").value,
    links: el("cvLinks").value
  };
  if (!payload.name.trim() || !payload.role.trim()) return;
  sessionStorage.setItem(storageKey("nova-cv-draft"), JSON.stringify({ requestId: form.dataset.requestId, payload }));
  button.disabled = true; status.hidden = false; status.textContent = "Se creează și se publică CV-ul…";
  try {
    const result = await api("/api/cv", jsonBody(payload));
    const projects = await api("/api/projects");
    state.projects = projects.projects;
    state.project = result.project.id;
    localStorage.setItem(storageKey("nova-project"), result.project.id);
    await loadProject(result.project.id);
    el("cvDialog").close();
    form.reset(); delete form.dataset.requestId; sessionStorage.removeItem(storageKey("nova-cv-draft"));
    setView("chat");
    addPublishedSiteCard(result.publication, "cv");
    toast("CV-ul este online și gata de trimis");
  } catch (error) {
    status.textContent = error.message;
  } finally { button.disabled = false; }
}

async function renameProject() {
  const current = state.projects.find(project => project.id === state.project); if (!current) return;
  const name = prompt("Noul nume al proiectului:", current.name); if (!name?.trim() || name.trim() === current.name) return;
  try {
    const result = await api("/api/project/rename", jsonBody({ project: state.project, name: name.trim() }));
    current.name = result.name; renderProjects(); toast("Proiect redenumit");
  } catch (error) { toast(error.message); }
}

async function deleteProject() {
  const current = state.projects.find(project => project.id === state.project); if (!current) return;
  if (!confirm(`Muți proiectul „${current.name}” în coșul proiectului? Îl poți restaura din butonul Restaurează. Modificările nesalvate se pierd.`)) return;
  try {
    await api("/api/project/delete", jsonBody({ project: current.id }));
    state.projects = state.projects.filter(project => project.id !== current.id); state.dirty = false; state.project = null;
    if (!state.projects.length) { await loadProjects(); }
    else { state.project = state.projects[0].id; localStorage.setItem(storageKey("nova-project"), state.project); renderProjects(); await loadProject(state.project); }
    toast("Proiect mutat în coș; îl poți restaura");
  } catch (error) { toast(error.message); }
}

async function restoreProject() {
  try {
    const { projects } = await api("/api/projects/trash");
    if (!projects.length) { toast("Nu există proiecte șterse"); return; }
    const choices = projects.map((project, index) => `${index + 1}. ${project.name} (${project.id})`).join("\n");
    const answer = prompt(`Alege numărul proiectului de restaurat:\n${choices}`);
    if (answer === null) return;
    const project = projects[Number.parseInt(answer, 10) - 1];
    if (!project) { toast("Număr invalid"); return; }
    await api("/api/project/restore", jsonBody({ project: project.id }));
    const data = await api("/api/projects"); state.projects = data.projects; state.project = project.id;
    localStorage.setItem(storageKey("nova-project"), project.id); renderProjects(); await loadProject(project.id); toast("Proiect restaurat");
  } catch (error) { toast(error.message); }
}

async function exportProject() {
  if (!state.project) return;
  try {
    const data = await api(`/api/project/export?project=${encodeURIComponent(state.project)}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
    const safeName = (data.name || "nova-project").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim() || "nova-project";
    link.download = `${safeName}.nova.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`${data.files.length} fișiere exportate`);
  } catch (error) { toast(error.message); }
}

function showPublication(publication) {
  state.publication = publication?.published ? publication : null;
  const link = el("publishedSiteLink"), unpublish = el("unpublishProjectBtn"), publish = el("publishProjectBtn");
  link.hidden = !state.publication; unpublish.hidden = !state.publication;
  publish.textContent = state.publication ? "Actualizează online" : "Publică online";
  if (state.publication) link.href = new URL(state.publication.url, location.origin).href;
  else link.removeAttribute("href");
}

async function refreshPublication() {
  if (!state.project) return showPublication(null);
  try { showPublication(await api(`/api/project/publication?project=${encodeURIComponent(state.project)}`)); }
  catch { showPublication(null); }
}

function addPublishedSiteCard(publication, type = "site") {
  const node = document.createElement("div"); node.className = "message assistant";
  const isCv = type === "cv";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = isCv ? "Nova CV · publicat online" : "Nova Business · site publicat";
  const textNode = document.createElement("div"); textNode.textContent = isCv ? "CV-ul este online. Deschide-l, descarcă-l ca PDF sau copiază linkul pentru a-l trimite." : "Site-ul este online. Îl poți actualiza oricând publicând din nou proiectul.";
  const url = new URL(publication.url, location.origin).href;
  const link = document.createElement("a"); link.className = "btn small"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.href = url; link.textContent = isCv ? "Deschide CV-ul" : "Deschide site-ul";
  const copy = document.createElement("button"); copy.className = "btn small"; copy.type = "button"; copy.textContent = "Copiază linkul"; copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); toast("Link copiat"); } catch { toast(`Link: ${url}`); } });
  node.append(meta, textNode, link, copy); messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
}

async function publishProject(openAfter = true) {
  if (!state.project) throw new Error("Alege un proiect pentru publicare.");
  if (state.dirty) await saveFile(false);
  const button = el("publishProjectBtn"); button.disabled = true;
  try {
    const publication = await api("/api/project/publish", jsonBody({ project: state.project }));
    showPublication(publication); toast("Site publicat online");
    if (openAfter) window.open(new URL(publication.url, location.origin).href, "_blank", "noopener,noreferrer");
    return publication;
  } finally { button.disabled = false; }
}

async function unpublishProject() {
  if (!state.project || !confirm("Oprești accesul public la acest site?")) return;
  await api("/api/project/unpublish", jsonBody({ project: state.project }));
  showPublication(null); toast("Publicarea a fost oprită");
}

async function importFolder(files) {
  if (!files.length) return;
  const textExtensions = /\.(js|jsx|mjs|cjs|ts|tsx|py|gpc|html?|css|scss|json|md|mdx|txt|xml|svg|ya?ml|toml|ini|cfg|conf|sh|bat|ps1|sql|go|rs|java|c|h|cpp|hpp|cs|php|rb|vue|svelte|lock)$/i;
  const allowedBasenames = new Set(["Dockerfile", "Makefile", ".gitignore", ".gitattributes", ".editorconfig"]);
  const selected = [];
  for (const file of files) {
    const relative = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    const parts = relative.split("/");
    const projectPath = (parts.length > 1 ? parts.slice(1) : parts).join("/");
    if (!projectPath || projectPath.split("/").some(part => !part || part === "." || part === ".." || [".git", "node_modules", ".nova-backups", ".nova-project.json"].includes(part))) continue;
    const basename = projectPath.split("/").pop();
    if (!(file.type.startsWith("text/") || textExtensions.test(projectPath) || allowedBasenames.has(basename))) continue;
    if (file.size > 512 * 1024) continue;
    selected.push({ file, path: projectPath });
  }
  if (!selected.length) { toast("Nu am găsit fișiere text sub 512 KiB de importat"); return; }
  const rootName = (files[0].webkitRelativePath || files[0].name).split(/[\\/]/)[0];
  const name = prompt("Numele proiectului importat:", rootName); if (!name?.trim()) return;
  try {
    const created = await api("/api/projects", jsonBody({ name: name.trim(), empty: true }));
    let imported = 0, failed = 0;
    for (const item of selected) {
      try {
        const content = await item.file.text();
        await api("/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: created.project.id, path: item.path, content }) });
        imported++;
      } catch { failed++; }
    }
    const data = await api("/api/projects"); state.projects = data.projects; state.project = created.project.id;
    localStorage.setItem(storageKey("nova-project"), state.project); renderProjects(); await loadProject(state.project);
    toast(failed ? `Importate ${imported} fișiere; ${failed} au eșuat` : `${imported} fișiere importate`);
  } catch (error) { toast(error.message); }
}

async function createFile() {
  if (!state.project) return;
  const name = prompt("Calea fișierului nou (ex.: src/app.js):"); if (!name?.trim()) return;
  if (state.files.some(file => file.path === name.trim()) && !confirm("Fișierul există deja. Îl deschid și îl suprascriu cu un fișier gol?")) return;
  try {
    await api("/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: state.project, path: name.trim(), content: "" }) });
    await refreshFiles(false); await openFile(name.trim(), true); state.dirty = true; el("dirtyMark").hidden = false; toast("Fișier creat");
  } catch (error) { toast(error.message); }
}

async function deleteFile() {
  if (!state.project || !state.activePath) return;
  if (!confirm(`Muți ${state.activePath} în coșul proiectului? Poți folosi Undo pentru a-l restaura.`)) return;
  try {
    if (state.dirty) await saveFile(false);
    await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(state.activePath)}`, { method: "DELETE" });
    state.dirty = false; await refreshFiles(false);
    if (state.activePath) await openFile(state.activePath, true); else { el("editor").value = ""; el("activeFileName").textContent = "Niciun fișier"; }
    toast("Fișier mutat în coș");
  } catch (error) { toast(error.message); }
}

async function undoFile() {
  if (!state.project || !state.activePath) return;
  if (state.dirty && !confirm("Undo va înlocui modificările nesalvate din editor. Continui?")) return;
  try {
    await api("/api/undo", jsonBody({ project: state.project, path: state.activePath }));
    state.dirty = false; await refreshFiles(false);
    if (state.files.some(file => file.path === state.activePath)) await openFile(state.activePath, true);
    else if (state.files.length) await openFile(state.files[0].path, true);
    toast("Ultima schimbare a fost anulată");
  } catch (error) { toast(error.message); }
}

async function send() {
  if (state.busy) return;
  const promptText = el("prompt").value.trim(), model = el("modelSelect").value;
  if (!promptText) return;
  if (el("taskSelect").value === "auto" && looksLikeCvCreationRequest(promptText)) {
    speakNextAssistant = false; el("prompt").value = ""; resizePrompt(); openCvBuilder(); return;
  }
  if (el("taskSelect").value === "image") {
    state.busy = true; el("sendBtn").disabled = true;
    try { await generateImageFromPrompt(); }
    finally { state.busy = false; el("sendBtn").disabled = false; }
    return;
  }
  if (!model) { speakNextAssistant = false; toast("Configurează furnizorul AI și alege un model."); return; }
  const workspaceWasOpen = el("app").classList.contains("workspace-open");
  setView("chat");
  const mode = el("modeSelect").value;
  const task = el("taskSelect").value;
  const allowChanges = mode === "build" && (state.account?.role === "owner" || el("allowChanges").checked);
  const currentProject = state.projects.find(project => project.id === state.project);
  const activeContent = state.activePath ? el("editor").value : "";
  const contextualPrompt = ["code", "business"].includes(task) || workspaceWasOpen
    ? `${promptText}\n\nProiect: ${currentProject?.name || state.project}\nFișier activ: ${state.activePath || "niciunul"}\nConținutul fișierului activ:\n\`\`\`${state.activePath?.split(".").pop() || "text"}\n${activeContent}\n\`\`\``
    : promptText;
  state.chat.push({ role: "user", content: contextualPrompt, displayContent: promptText });
  localStorage.setItem(chatKey(), JSON.stringify(state.chat));
  addBubble("user", promptText); el("prompt").value = "";
  const directCreation = ["text", "lyrics"].includes(task);
  const pending = document.createElement("div"); pending.className = "thinking"; pending.textContent = directCreation
    ? (task === "lyrics" ? "Nova compune versurile complete…" : "Nova redactează textul complet…")
    : mode === "build" ? "Agentul explorează proiectul…" : mode === "plan" ? "Nova pregătește planul…" : "Nova revizuiește codul…";
  messageContainer().append(pending); el("messages").scrollTop = el("messages").scrollHeight;
  state.busy = true; el("sendBtn").disabled = true;
  try {
    if (!directCreation && state.dirty) await saveFile(false);
    const messages = state.chat.map(({ role, content }) => ({ role, content }));
    const result = directCreation
      ? await api("/api/chat", jsonBody({ model, task, verifyWeb: false, messages }))
      : await api("/api/agent", jsonBody({ project: state.project, model, mode, task, allowChanges, verifyWeb: el("verifyWeb").checked, messages }));
    const assistantContent = result.content;
    state.chat.push({ role: "assistant", content: assistantContent });
    localStorage.setItem(chatKey(), JSON.stringify(state.chat));
    const events = Array.isArray(result.events) ? result.events : [];
    addBubble("assistant", assistantContent, events, result);
    const wroteFiles = events.some(event => event.ok && event.tool === "write_file");
    if (wroteFiles) {
      await refreshFiles(false);
      if (state.activePath && state.files.some(file => file.path === state.activePath)) await openFile(state.activePath, true);
      toast("Agentul a salvat modificările. Folosește Undo pentru a reveni.");
    }
    if (task === "business" && wroteFiles) {
      try { addPublishedSiteCard(await publishProject(false)); }
      catch (error) { addBubble("assistant", `Site-ul a fost creat, dar publicarea nu a reușit: ${error.message}`); }
    }
  } catch (error) {
    addBubble("assistant", error.message || "Nu am putut contacta agentul.");
  } finally {
    pending.remove(); state.busy = false; el("sendBtn").disabled = false; el("prompt").focus();
  }
}

el("editor").addEventListener("input", () => { state.dirty = true; el("dirtyMark").hidden = false; updateLines(); });
el("editor").addEventListener("scroll", () => { el("gutter").scrollTop = el("editor").scrollTop; });
el("saveBtn").addEventListener("click", () => saveFile(true).catch(error => toast(error.message)));
el("sendBtn").addEventListener("click", send);
el("generateImageBtn").addEventListener("click", generateImageFromPrompt);
el("editImageBtn").addEventListener("click", openImageEditDialog);
el("imageEditFile").addEventListener("change", showImageEditPreview);
el("generateImageEditBtn").addEventListener("click", generateImageEdit);
el("imageEditSettingsBtn").addEventListener("click", () => { el("imageEditDialog").close(); el("providerSettingsBtn").click(); });
el("imageEditDialog").addEventListener("close", () => {
  if (imageEditPreviewUrl) URL.revokeObjectURL(imageEditPreviewUrl);
  imageEditPreviewUrl = ""; el("imageEditPreview").hidden = true; el("imageEditPreview").removeAttribute("src"); el("imageEditFile").value = "";
});
el("voiceComposerBtn").addEventListener("click", openVoiceDialog);
el("voiceChatBtn").addEventListener("click", () => startVoiceChat("prompt"));
el("homeVoiceChatBtn").addEventListener("click", () => startVoiceChat("homePrompt"));
el("sideVoiceBtn").addEventListener("click", () => { setView("chat"); openVoiceDialog(); });
el("generateVoiceBtn").addEventListener("click", generateVoiceFromDialog);
el("voiceText").addEventListener("input", updateVoiceCost);
el("voiceSettingsBtn").addEventListener("click", () => { el("voiceDialog").close(); el("providerSettingsBtn").click(); });
const accountMenu = document.querySelector(".account-menu");
accountMenu.addEventListener("click", event => {
  if (event.target.closest(".account-action")) accountMenu.open = false;
});
document.addEventListener("click", event => {
  if (!accountMenu.contains(event.target)) accountMenu.open = false;
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") accountMenu.open = false;
});
el("providerSettingsBtn").addEventListener("click", async () => {
  if (state.account?.role !== "owner") return;
  try { await loadProviderSettings(); el("providerDialog").showModal(); }
  catch (error) { toast(error.message); }
});
el("railProviderSettings").addEventListener("click", () => {
  if (state.account?.role !== "owner") { toast("Furnizorii sunt administrați de owner."); return; }
  el("providerSettingsBtn").click();
});
el("providerSelect").addEventListener("change", event => {
  if (providerDraftDirty && !window.confirm("Ai modificări nesalvate pentru acest profil. Le abandonezi?")) {
    event.target.value = editingProviderId;
    return;
  }
  renderProviderProfile(event.target.value);
});
el("searchProvider").addEventListener("change", event => {
  if (searchDraftDirty && !window.confirm("Ai o cheie de căutare nesalvată. Abandonezi modificarea?")) {
    event.target.value = editingSearchProvider;
    return;
  }
  renderSearchProfile(event.target.value);
  searchDraftDirty = event.target.value !== state.settings?.search?.provider;
});
el("providerFields").addEventListener("input", () => { providerDraftDirty = true; });
el("providerFields").addEventListener("change", () => { providerDraftDirty = true; });
["routeText", "routeImage", "routeSpeech", "autoSelectProvider", "autoFallback"].forEach(id => {
  el(id).addEventListener("change", () => { providerDraftDirty = true; });
});
["searchApiKey", "clearSearchApiKey"].forEach(id => {
  el(id).addEventListener("input", () => { searchDraftDirty = true; });
  el(id).addEventListener("change", () => { searchDraftDirty = true; });
});
el("providerDialog").addEventListener("close", () => {
  el("apiKey").value = ""; el("searchApiKey").value = "";
  el("clearApiKey").checked = false; el("clearSearchApiKey").checked = false;
  providerDraftDirty = false; searchDraftDirty = false;
});
el("testWebConnection").addEventListener("click", testWebConnection);
el("providerForm").addEventListener("submit", event => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    el("providerDialog").close("cancel");
    return;
  }
  saveProviderSettings().catch(error => toast(error.message));
});
el("taskSelect").addEventListener("change", event => {
  setTask(event.target.value);
});
document.querySelectorAll(".create-item[data-task], .mode-chip[data-task]").forEach(button => button.addEventListener("click", () => {
  setTask(button.dataset.task);
  setView("chat");
  el("prompt").focus();
}));
document.querySelectorAll(".global-nav-link[data-view]").forEach(button => button.addEventListener("click", () => {
  const view = button.dataset.view;
  if (["home", "chat"].includes(view)) setTask("auto");
  if (view === "create") {
    setView("create");
    requestAnimationFrame(() => el("homeTools").scrollIntoView({ behavior: "smooth", block: "start" }));
  } else if (view === "explore") {
    setView("explore");
    requestAnimationFrame(() => el("projectsTitle").scrollIntoView({ behavior: "smooth", block: "start" }));
  } else setView(view);
  if (view === "chat") el("prompt").focus();
}));
el("topSearchBtn").addEventListener("click", () => {
  if (state.view === "chat") el("prompt").focus();
  else { el("homePrompt").focus(); el("homePrompt").scrollIntoView({ behavior: "smooth", block: "center" }); }
});
el("projectsNavBtn").addEventListener("click", () => setProjectsOpen(!el("app").classList.contains("projects-open")));
el("railProjectsBtn").addEventListener("click", () => setProjectsOpen(true));
el("projectDrawer").addEventListener("toggle", event => {
  const open = event.currentTarget.open;
  el("app").classList.toggle("projects-open", open);
  el("projectsNavBtn").setAttribute("aria-expanded", String(open));
  if (open) setSidebarActive(el("projectsNavBtn"));
  else {
    const task = el("taskSelect").value;
    setSidebarActive(state.view === "home"
      ? document.querySelector('.create-item[data-view="home"]')
      : document.querySelector(task === "auto" ? '.create-item[data-view="chat"]' : `.create-item[data-task="${task}"]`));
  }
});
el("app").addEventListener("click", event => {
  if (event.target === el("app") && el("app").classList.contains("projects-open")) setProjectsOpen(false);
});
el("seeProjectsBtn").addEventListener("click", () => setProjectsOpen(true));
el("newHomeProjectBtn").addEventListener("click", () => createProject());
el("homeProjects").addEventListener("click", async event => {
  const createCard = event.target.closest("[data-create-project]");
  if (createCard) { createProject(createCard.dataset.createProject); return; }
  const card = event.target.closest("[data-project-id]");
  if (!card) return;
  try {
    const id = card.dataset.projectId;
    if (id !== state.project) { await loadProject(id); localStorage.setItem(storageKey("nova-project"), id); }
    setView("chat");
    if (!el("app").classList.contains("workspace-open")) el("openWorkspaceBtn").click();
  } catch (error) { toast(error.message); }
});
el("resumeChatBtn").addEventListener("click", () => { setView("chat"); el("prompt").focus(); });
function submitHomePrompt() {
  const value = el("homePrompt").value.trim();
  if (!value || state.busy) return;
  if (looksLikeCvCreationRequest(value)) { el("homePrompt").value = ""; openCvBuilder(); return; }
  el("prompt").value = value; el("homePrompt").value = ""; resizePrompt(); setView("chat"); send();
}
el("homeSendBtn").addEventListener("click", submitHomePrompt);
el("homePrompt").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitHomePrompt(); }
});
el("dashboardSearch").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const value = event.currentTarget.value.trim();
  if (!value) return;
  el("homePrompt").value = value; event.currentTarget.value = ""; submitHomePrompt();
});
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault(); el("dashboardSearch").focus();
  }
});
document.querySelectorAll("[data-quick-prompt]").forEach(button => button.addEventListener("click", () => {
  setTask(button.dataset.quickTask || "auto");
  el("homePrompt").value = button.dataset.quickPrompt; el("homePrompt").focus();
}));
el("homeVoiceBtn").addEventListener("click", () => {
  const value = el("homePrompt").value.trim();
  if (value) { el("prompt").value = value; el("voiceText").value = value; el("homePrompt").value = ""; }
  setView("chat"); openVoiceDialog();
});
el("creatorHome").addEventListener("click", async event => {
  const card = event.target.closest("[data-home-action]");
  if (!card) return;
  const action = card.dataset.homeAction;
  const draft = el("homePrompt").value.trim();
  if (action === "cv") { openCvBuilder(); return; }
  if (["chat", "code", "text", "lyrics", "business"].includes(action)) {
    const task = action === "chat" ? "auto" : action;
    setTask(task); if (draft) { el("prompt").value = draft; el("homePrompt").value = ""; resizePrompt(); }
    setView("chat"); el("prompt").focus(); return;
  }
  if (action === "image") {
    setTask("image");
    if (!draft) { setView("chat"); el("prompt").placeholder = "Descrie imaginea pe care vrei s-o creezi…"; el("prompt").focus(); return; }
    el("prompt").value = draft; el("homePrompt").value = ""; await generateImageFromPrompt(); return;
  }
});
el("prompt").addEventListener("input", resizePrompt);
el("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } });
el("refreshModels").addEventListener("click", refreshHealth);
el("refreshModelsTop").addEventListener("click", refreshHealth);
el("newProjectBtn").addEventListener("click", createProject);
el("openCvBuilderBtn").addEventListener("click", openCvBuilder);
el("cvForm").addEventListener("submit", event => { event.preventDefault(); createCvOnline(); });
el("newProjectForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = el("newProjectName").value.trim();
  if (!name) { el("newProjectName").focus(); return; }
  saveNewProject(name).then(created => { if (created) el("newProjectDialog").close(); });
});
el("renameProjectBtn").addEventListener("click", renameProject);
el("deleteProjectBtn").addEventListener("click", deleteProject);
el("restoreProjectBtn").addEventListener("click", restoreProject);
el("exportProjectBtn").addEventListener("click", exportProject);
el("publishProjectBtn").addEventListener("click", () => publishProject(true).catch(error => toast(error.message)));
el("unpublishProjectBtn").addEventListener("click", () => unpublishProject().catch(error => toast(error.message)));
el("importProjectBtn").addEventListener("click", () => el("folderImport").click());
el("folderImport").addEventListener("change", event => { importFolder(Array.from(event.target.files || [])).finally(() => { event.target.value = ""; }); });
el("fileSearch").addEventListener("input", event => { state.filter = event.target.value.trim(); renderFiles(); });
el("newFileBtn").addEventListener("click", createFile);
el("deleteFileBtn").addEventListener("click", deleteFile);
el("undoBtn").addEventListener("click", undoFile);
el("projectSelect").addEventListener("change", async event => { try { await loadProject(event.target.value); localStorage.setItem(storageKey("nova-project"), event.target.value); } catch (error) { toast(error.message); } });
el("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); window.location.replace("/"); }
  catch (error) { toast(error.message); }
});
el("deleteAccountBtn").addEventListener("click", async () => {
  const username = state.account?.username || "";
  if (!username || !confirm("Contul, proiectele și site-urile publicate vor fi șterse definitiv. Continui?")) return;
  const confirmation = prompt(`Pentru confirmare, scrie exact numele contului: ${username}`);
  if (confirmation !== username) { toast("Numele introdus nu corespunde contului."); return; }
  const button = el("deleteAccountBtn");
  button.disabled = true;
  try {
    await api("/api/auth/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }) });
    const accountSuffix = `-${state.account.id}`;
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (key?.endsWith(accountSuffix)) storage.removeItem(key);
      }
    }
    window.location.replace("/?account=deleted");
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
});
el("clearChat").addEventListener("click", () => {
  state.chat = [];
  localStorage.setItem(chatKey(), "[]");
  setTask("auto");
  el("prompt").value = "";
  el("homePrompt").value = "";
  resizePrompt();
  renderChat();
  setView("home");
});
el("newChatTop").addEventListener("click", () => el("clearChat").click());
function setWorkspaceOpen(open) {
  el("app").classList.toggle("workspace-open", open);
  el("openWorkspaceBtn").setAttribute("aria-pressed", String(open));
  el("openWorkspaceBtn").lastElementChild.textContent = open ? "Închide editorul" : "Spațiu de lucru";
  if (open) renderFiles();
}
el("closeWorkspaceBtn").addEventListener("click", () => {
  setWorkspaceOpen(false);
  el("openWorkspaceBtn").focus();
});
el("openWorkspaceBtn").addEventListener("click", () => {
  setWorkspaceOpen(!el("app").classList.contains("workspace-open"));
});
el("copyBtn").addEventListener("click", async () => { try { await navigator.clipboard.writeText(el("editor").value); toast("Cod copiat"); } catch { toast("Clipboard indisponibil în acest context"); } });
el("downloadBtn").addEventListener("click", () => {
  const blob = new Blob([el("editor").value], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = state.activePath?.split("/").pop() || "nova.txt"; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
const projectDrawer = el("projectDrawer");
if (projectDrawer) {
  projectDrawer.open = false;
}
window.addEventListener("beforeunload", event => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/service-worker.js").catch(() => {}));

loadAccount().then(() => Promise.all([loadProviderSettings(), loadProjects()])).catch(error => {
  el("projectName").textContent = "Server indisponibil"; toast(error.message);
}).then(() => {
  if (state.account?.role === "owner" && new URLSearchParams(location.search).get("settings") === "ai") {
    const url = new URL(location.href); url.searchParams.delete("settings"); history.replaceState(null, "", url);
    el("providerSettingsBtn").click();
  }
});


