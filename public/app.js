const el = id => document.getElementById(id);
const state = { projects: [], project: null, files: [], activePath: null, dirty: false, chat: [], busy: false, filter: "", settings: null, account: null, view: "home" };
let activeMessageStream = null;
const fileIcons = { js: "JS", mjs: "JS", cjs: "JS", ts: "TS", py: "PY", md: "MD", css: "{}", html: "<>", json: "{}", gpc: "GPC" };
const starterProjectNames = ["Mountain Escape", "Travel App", "Neon Dreams", "Old Beat", "Band City"];

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const remaining = response.headers.get("x-nova-ai-remaining");
  if (remaining !== null && state.account?.role === "subscriber") {
    state.account.remainingToday = Number(remaining);
    el("accountLabel").textContent = `${state.account.username} · Abonat · ${state.account.remainingToday}/${state.account.dailyLimit} cereri AI azi`;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.location.replace("/?session=expired");
    throw new Error(data.error || `Cererea a eșuat (${response.status}).`);
  }
  return data;
}
function jsonBody(value) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }; }
function toast(text) { const node = el("toast"); node.textContent = text; node.classList.add("show"); setTimeout(() => node.classList.remove("show"), 2200); }
function iconFor(name) { return fileIcons[name.split(".").pop().toLowerCase()] || "·"; }
function storageKey(key) { return state.account?.role === "subscriber" ? `${key}-${state.account.id}` : key; }
function activeKey(project = state.project) { return storageKey(`nova-active-file-${project}`); }
function chatKey(project = state.project) { return storageKey(`nova-chat-${project}`); }

async function loadAccount() {
  const account = await api("/api/auth/me"); state.account = account;
  const subscriber = account.role === "subscriber";
  el("providerSettingsBtn").hidden = subscriber;
  el("voiceSettingsBtn").hidden = subscriber;
  el("adminDashboardLink").hidden = subscriber;
  el("logoutBtn").hidden = !account.authEnabled;
  el("accountLabel").textContent = subscriber
    ? `${account.username} · Abonat · ${account.remainingToday}/${account.dailyLimit} cereri AI azi`
    : `${account.username} · Administrator`;
  el("accountAvatarLabel").textContent = account.username.slice(0, 1).toUpperCase();
}

async function refreshHealth() {
  const badge = el("statusBadge"), dot = el("connectionDot"), label = el("connectionText"), select = el("modelSelect");
  const sideDot = el("sidebarConnectionDot"), sideLabel = el("sidebarConnectionText");
  const localInstance = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  el("instanceBadge").textContent = localInstance ? "LOCAL" : "ONLINE PRIVAT";
  el("projectStorageLabel").textContent = localInstance ? "Fișiere pe acest calculator" : "Fișiere pe serverul privat";
  try {
    const data = await api("/api/health");
    if (!data.connected) {
      const message = data.error || (data.provider === "openai" ? "Cheia API lipsește" : "Ollama nu este disponibil");
      label.title = message;
      sideLabel.title = message;
      throw new Error(message);
    }
    label.removeAttribute("title"); sideLabel.removeAttribute("title");
    dot.classList.add("on"); label.textContent = data.provider === "openai" ? `OpenAI · ${data.version}` : `Ollama ${data.version}`;
    sideDot.classList.add("on"); sideLabel.textContent = data.provider === "openai" ? "OpenAI conectat" : "Ollama conectat";
    badge.textContent = data.provider === "openai" ? "OpenAI · conexiune verificată" : "Ollama conectat";
    badge.style.color = "var(--green)"; badge.style.borderColor = "#364131";
    const previous = select.value; select.replaceChildren();
    if (!data.models.length) select.add(new Option(data.provider === "openai" ? "Setează modelul cloud" : "Niciun model instalat", ""));
    else { data.models.forEach(model => select.add(new Option(model, model))); if (data.models.includes(previous)) select.value = previous; }
  } catch (error) {
    dot.classList.remove("on"); label.textContent = state.settings?.provider === "openai" ? "OpenAI neconectat" : "Ollama deconectat"; badge.textContent = "AI neconectat";
    sideDot.classList.remove("on");
    const reason = error?.message || (state.settings?.provider === "openai" ? "Verifică OPENAI_API_KEY în Render." : "Pornește Ollama și reîncarcă.");
    sideLabel.textContent = reason;
    label.title = reason; sideLabel.title = reason; badge.title = reason;
    badge.style.color = "#e4a69b"; badge.style.borderColor = "#583b35";
    select.replaceChildren(new Option(state.settings?.provider === "openai" ? "Configurează cheia API" : "Pornește Ollama și reîncarcă", ""));
  }
}

async function loadProviderSettings() {
  const { settings } = await api("/api/settings"); state.settings = settings;
  el("providerSelect").value = settings.provider;
  el("apiBaseUrl").value = settings.baseUrl;
  el("textModel").value = settings.textModel;
  el("imageModel").value = settings.imageModel;
  el("speechModel").value = settings.speechModel;
  el("voiceSelect").value = settings.voice;
  el("apiKey").value = "";
  el("clearApiKey").checked = false;
  el("apiKeyState").textContent = settings.apiKeyConfigured
    ? "O cheie este deja configurată. Lasă câmpul gol pentru a o păstra. Cheia nu este returnată în browser."
    : "Cheia nu este afișată sau salvată în proiect. Pentru găzduire, configureaz-o în secretele serverului.";
  el("openAiFields").hidden = settings.provider !== "openai";
  await refreshHealth();
}

async function saveProviderSettings() {
  const settings = {
    provider: el("providerSelect").value,
    baseUrl: el("apiBaseUrl").value.trim(),
    apiKey: el("apiKey").value,
    clearApiKey: el("clearApiKey").checked,
    textModel: el("textModel").value.trim(),
    imageModel: el("imageModel").value.trim(),
    speechModel: el("speechModel").value.trim(),
    voice: el("voiceSelect").value
  };
  const result = await api("/api/settings", jsonBody(settings));
  state.settings = result.settings; el("apiKey").value = "";
  el("providerDialog").close(); await refreshHealth();
  toast(settings.provider === "openai" ? "Conexiunea AI cloud a fost salvată" : "Ollama local a fost selectat");
}

function renderProjects() {
  const select = el("projectSelect"); select.replaceChildren();
  for (const project of state.projects) select.add(new Option(project.name, project.id));
  if (state.project) select.value = state.project;
  const current = state.projects.find(project => project.id === state.project);
  el("projectName").textContent = current?.name || "Niciun proiect";
  renderHomeProjects();
}

function renderHomeProjects() {
  const list = el("homeProjects");
  if (!list) return;
  list.replaceChildren();
  const projects = state.projects.slice(0, 5);
  projects.forEach((project, index) => {
    const card = document.createElement("button"); card.className = `home-project-card project-tone-${index % 5}`; card.type = "button";
    card.dataset.projectId = project.id;
    card.setAttribute("aria-label", `Open project ${project.name}`);
    const cover = document.createElement("span"); cover.className = `project-cover cover-${index % 5}`; cover.setAttribute("aria-hidden", "true");
    const scene = document.createElement("span"); scene.className = "cover-scene";
    const glow = document.createElement("span"); glow.className = "cover-glow";
    const detailLines = document.createElement("span"); detailLines.className = "cover-detail";
    cover.append(glow, scene, detailLines);
    const name = document.createElement("strong"); name.className = "project-name"; name.textContent = project.name;
    const detail = document.createElement("small"); detail.className = "project-description";
    detail.textContent = project.id === state.project ? `${state.files.length} file${state.files.length === 1 ? "" : "s"} · Open` : "Open project";
    card.append(cover, name, detail); list.append(card);
  });
  for (let index = projects.length; index < 5; index++) {
    const card = document.createElement("button"); card.type = "button";
    card.className = `home-project-card project-create-card project-tone-${index % 5}`;
    card.dataset.createProject = starterProjectNames[index];
    card.setAttribute("aria-label", `Create project ${starterProjectNames[index]}`);
    const cover = document.createElement("span"); cover.className = `project-cover cover-${index % 5}`; cover.setAttribute("aria-hidden", "true");
    const scene = document.createElement("span"); scene.className = "cover-scene";
    const glow = document.createElement("span"); glow.className = "cover-glow";
    const detailLines = document.createElement("span"); detailLines.className = "cover-detail";
    const plus = document.createElement("span"); plus.className = "project-create-plus"; plus.setAttribute("aria-hidden", "true"); plus.textContent = "+";
    cover.append(glow, scene, detailLines, plus);
    const name = document.createElement("strong"); name.className = "project-name"; name.textContent = starterProjectNames[index];
    const detail = document.createElement("small"); detail.className = "project-description"; detail.textContent = "Create this project";
    card.append(cover, name, detail); list.append(card);
  }
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

function setView(view) {
  state.view = view === "chat" ? "chat" : "home";
  if (state.view === "home" && el("prompt").value.trim() && !el("homePrompt").value.trim()) el("homePrompt").value = el("prompt").value;
  el("chat").classList.toggle("home-active", state.view === "home");
  if (state.view === "chat") setWorkspaceOpen(false);
  setProjectsOpen(false);
  const activeView = ["create", "explore"].includes(view) ? view : state.view;
  document.querySelectorAll(".global-nav-link[data-view]").forEach(button => {
    const active = button.dataset.view === activeView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  updateHomeHistory();
}

function setProjectsOpen(open) {
  const app = el("app"), drawer = el("projectDrawer"), button = el("projectsNavBtn");
  app?.classList.toggle("projects-open", open);
  if (drawer) drawer.open = open;
  if (button) button.setAttribute("aria-expanded", String(open));
  button?.classList.toggle("active", open);
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
  const supported = ["auto", "code", "lyrics", "music", "video"];
  const selected = supported.includes(task) ? task : "auto";
  el("taskSelect").value = selected;
  document.querySelectorAll(".create-item, .mode-chip").forEach(button => button.classList.toggle("active", button.dataset.task === selected));
  const prompts = {
    auto: "Descrie ce vrei să creezi… (Enter trimite, Shift+Enter pentru rând nou)",
    code: "Descrie aplicația sau unealta pe care vrei să o construiești…",
    lyrics: "Descrie tema, stilul și atmosfera textului sau a versurilor…",
    music: "Descrie genul, tempo-ul și starea compoziției…",
    video: "Descrie ideea, publicul și stilul videoclipului…"
  };
  el("prompt").placeholder = prompts[selected];
}

function resizePrompt() {
  const prompt = el("prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 190)}px`;
}

function parseCreativeSpec(content) {
  const match = content.match(/```nova-(music|video)\s*([\s\S]*?)```/i);
  if (!match) return { text: content, spec: null };
  try {
    const raw = JSON.parse(match[2]);
    const title = String(raw.title || (match[1] === "music" ? "Compoziție Nova" : "Video Nova")).slice(0, 100);
    if (match[1].toLowerCase() === "music") {
      const notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 128).map(item => ({
        note: String(item.note || ""), beats: Math.min(4, Math.max(0.25, Number(item.beats) || 1))
      })).filter(item => /^[A-G]#?[2-6]$/.test(item.note));
      if (!notes.length) throw new Error("Nu există note valide.");
      return { text: content.replace(match[0], "").trim(), spec: { type: "music", title, bpm: Math.min(180, Math.max(50, Number(raw.bpm) || 96)), notes } };
    }
    const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, 12).map(scene => ({
      text: String(scene.text || "").slice(0, 280),
      seconds: Math.min(8, Math.max(2, Number(scene.seconds) || 4)),
      background: /^#[0-9a-f]{6}$/i.test(String(scene.background || "")) ? scene.background : "#18221a"
    })).filter(scene => scene.text.trim());
    if (scenes.length < 2) throw new Error("Videoclipul are nevoie de cel puțin două scene.");
    return { text: content.replace(match[0], "").trim(), spec: { type: "video", title, scenes } };
  } catch {
    return { text: content, spec: null };
  }
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

function noteFrequency(note) {
  const match = note.match(/^([A-G])(#?)([2-6])$/);
  if (!match) return 220;
  const semitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]] + (match[2] ? 1 : 0);
  const midi = (Number(match[3]) + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

async function createWav(spec) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error("Browserul nu acceptă export audio local.");
  const rate = 22050, beatSeconds = 60 / spec.bpm;
  const duration = Math.min(90, spec.notes.reduce((sum, item) => sum + item.beats * beatSeconds, 0) + 0.2);
  const audio = new Offline(1, Math.ceil(duration * rate), rate);
  let cursor = 0;
  for (const item of spec.notes) {
    const start = cursor, end = Math.min(duration - 0.02, start + item.beats * beatSeconds);
    if (end <= start) break;
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = "triangle"; oscillator.frequency.value = noteFrequency(item.note);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.12, Math.min(end, start + 0.025));
    gain.gain.setValueAtTime(0.12, Math.max(start + 0.03, end - 0.04));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(audio.destination); oscillator.start(start); oscillator.stop(end);
    cursor += item.beats * beatSeconds;
    if (cursor >= duration) break;
  }
  return audio.startRendering();
}

function audioBufferToWav(buffer) {
  const samples = buffer.getChannelData(0), bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true); }
  return new Blob([bytes], { type: "audio/wav" });
}

function drawVideoFrame(ctx, spec, elapsed, width, height) {
  const total = spec.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  const time = Math.min(Math.max(elapsed, 0), Math.max(0, total - 0.001));
  let cursor = 0, index = 0;
  for (; index < spec.scenes.length - 1; index++) { if (time < cursor + spec.scenes[index].seconds) break; cursor += spec.scenes[index].seconds; }
  const scene = spec.scenes[index], progress = Math.min(1, (time - cursor) / scene.seconds);
  const image = spec.sceneImages?.[index];
  if (image) {
    const scale = Math.max(width / image.width, height / image.height), drawWidth = image.width * scale, drawHeight = image.height * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    const shade = ctx.createLinearGradient(0, 0, 0, height); shade.addColorStop(0, "rgba(0,0,0,.22)"); shade.addColorStop(.5, "rgba(0,0,0,.48)"); shade.addColorStop(1, "rgba(0,0,0,.65)"); ctx.fillStyle = shade; ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = scene.background; ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width * 0.76, height * 0.16, 2, width * 0.76, height * 0.16, width * 0.8);
    glow.addColorStop(0, "rgba(255,255,255,.13)"); glow.addColorStop(1, "rgba(0,0,0,.3)"); ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = "rgba(255,255,255,.72)"; ctx.font = "600 22px Segoe UI, sans-serif"; ctx.textAlign = "left"; ctx.fillText(spec.title, 72, 72);
  ctx.fillStyle = "#f5f5f0"; ctx.font = "700 52px Segoe UI, sans-serif"; ctx.textAlign = "center";
  const words = scene.text.split(/\s+/), lines = []; let line = "";
  for (const word of words) { const candidate = line ? `${line} ${word}` : word; if (ctx.measureText(candidate).width > width - 180 && line) { lines.push(line); line = word; } else line = candidate; }
  if (line) lines.push(line);
  const shown = lines.slice(0, 5), lineHeight = 66, y = (height - shown.length * lineHeight) / 2;
  ctx.globalAlpha = Math.min(1, progress * 5 + 0.1);
  shown.forEach((text, i) => ctx.fillText(text, width / 2, y + i * lineHeight, width - 140));
  ctx.globalAlpha = 1; ctx.fillStyle = "rgba(255,255,255,.24)"; ctx.fillRect(72, height - 54, width - 144, 5);
  ctx.fillStyle = "#b4ed79"; ctx.fillRect(72, height - 54, (width - 144) * Math.min(1, time / total), 5);
  ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = "16px Segoe UI, sans-serif"; ctx.textAlign = "right"; ctx.fillText(`${index + 1} / ${spec.scenes.length}`, width - 72, height - 72);
}

async function exportVideo(spec) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error("Browserul nu acceptă export video WebM local.");
  spec.sceneImages = await Promise.all(spec.scenes.map(scene => scene.image ? new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = scene.image; }) : null));
  const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d"), stream = canvas.captureStream(24);
  let voice = null, audioContext = null;
  if (spec.voiceDataUrl && window.AudioContext) {
    audioContext = new AudioContext(); voice = new Audio(spec.voiceDataUrl); voice.preload = "auto";
    const source = audioContext.createMediaElementSource(voice), destination = audioContext.createMediaStreamDestination();
    source.connect(destination); stream.addTrack(destination.stream.getAudioTracks()[0]);
    await new Promise(resolve => { if (voice.readyState >= 1) resolve(); else { voice.onloadedmetadata = resolve; voice.onerror = resolve; } });
  }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error("Browserul nu oferă un format WebM compatibil.");
  const chunks = [], recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
  const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = () => reject(new Error("Exportul video a eșuat.")); });
  const sceneDuration = Math.min(60, spec.scenes.reduce((sum, scene) => sum + scene.seconds, 0));
  const total = Math.min(120, Math.max(sceneDuration, Number(voice?.duration) || 0));
  drawVideoFrame(ctx, spec, 0, canvas.width, canvas.height);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.start(250);
  if (voice) { await audioContext.resume(); await voice.play(); }
  await new Promise(resolve => { const start = performance.now(); const frame = now => { const elapsed = (now - start) / 1000; drawVideoFrame(ctx, spec, elapsed, canvas.width, canvas.height); if (elapsed >= total) { recorder.stop(); resolve(); } else requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
  await stopped; stream.getTracks().forEach(track => track.stop()); voice?.pause(); if (audioContext) await audioContext.close();
  return new Blob(chunks, { type: mime });
}

async function generateSpeech(text) {
  return api("/api/media/speech", jsonBody({ text: text.trim().slice(0, 4000) }));
}

function openVoiceDialog() {
  const dialog = el("voiceDialog"), voiceText = el("voiceText"), status = el("voiceStatus");
  if (!voiceText.value.trim() && el("prompt").value.trim()) voiceText.value = el("prompt").value.trim();
  status.hidden = true; status.textContent = ""; status.classList.remove("error");
  dialog.showModal(); voiceText.focus();
}

function addVoiceCard(text, result) {
  const node = document.createElement("div"); node.className = "message assistant";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = `Voice-over AI · ${result.model}`;
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
    const result = await generateSpeech(text);
    setView("chat");
    addBubble("user", `Creează un voice-over MP3: ${text}`);
    addVoiceCard(text, result);
    el("voiceDialog").close(); el("voiceText").value = ""; status.hidden = true;
  } catch (error) {
    status.classList.add("error"); status.textContent = error.message || "Generarea voice-over-ului a eșuat.";
  } finally { button.disabled = false; button.textContent = "Generează MP3"; }
}

function addSpeechButton(node, text, label = "Ascultă cu voce AI") {
  const button = document.createElement("button"); button.className = "btn small"; button.textContent = label;
  const output = document.createElement("div"); output.className = "creative-output";
  button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "Se generează vocea…";
    try {
      const speech = await generateSpeech(text), player = document.createElement("audio"); player.controls = true; player.src = speech.dataUrl;
      const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă voice-over MP3"; link.href = speech.dataUrl; link.download = "nova-voice-over.mp3";
      output.replaceChildren(player, link); button.textContent = "Generează din nou";
    } catch (error) { toast(error.message); button.textContent = label; }
    finally { button.disabled = false; }
  });
  node.append(button, output);
}

function addImageCard(prompt, result) {
  const node = document.createElement("div"); node.className = "message assistant";
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = `Imagine AI · ${result.model}`;
  const caption = document.createElement("div"); caption.textContent = prompt;
  const img = document.createElement("img"); img.className = "creative-image"; img.alt = prompt; img.src = result.dataUrl;
  const link = document.createElement("a"); link.className = "btn small"; link.textContent = `Descarcă ${(result.format || "png").toUpperCase()}`; link.href = result.dataUrl; link.download = safeMediaName(prompt.slice(0, 48), result.format || "png");
  node.append(meta, caption, img, link); messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
}

async function generateImageFromPrompt() {
  const prompt = el("prompt").value.trim(); if (!prompt) { toast("Descrie imaginea în caseta de chat."); return; }
  setView("chat");
  const button = el("generateImageBtn"); button.disabled = true;
  addBubble("user", `Creează imagine: ${prompt}`);
  const pending = document.createElement("div"); pending.className = "thinking"; pending.textContent = "Se generează imaginea…"; messageContainer().append(pending);
  el("prompt").value = "";
  try { const result = await api("/api/media/image", jsonBody({ prompt })); addImageCard(prompt, result); }
  catch (error) { addBubble("assistant", error.message); }
  finally { pending.remove(); button.disabled = false; }
}

function addCreativeCard(node, spec) {
  const card = document.createElement("div"); card.className = "creative-card";
  const heading = document.createElement("strong"); heading.textContent = spec.type === "music" ? `♫ ${spec.title}` : `▶ ${spec.title}`;
  const detail = document.createElement("div"); detail.className = "creative-detail";
  const action = document.createElement("button"); action.className = "btn small";
  const output = document.createElement("div"); output.className = "creative-output";
  if (spec.type === "music") {
    detail.textContent = `${spec.bpm} BPM · ${spec.notes.length} note · sintetizator simplu`;
    action.textContent = "Generează WAV";
    action.addEventListener("click", async () => { action.disabled = true; detail.textContent = "Se sintetizează audio local…"; try { const blob = audioBufferToWav(await createWav(spec)); const player = document.createElement("audio"); player.controls = true; player.src = URL.createObjectURL(blob); const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă WAV"; link.href = player.src; link.download = safeMediaName(spec.title, "wav"); output.replaceChildren(player, link); detail.textContent = "Audio sintetizat local · fără voce cântată"; } catch (error) { detail.textContent = error.message; } finally { action.disabled = false; } });
  } else {
    detail.textContent = `${spec.scenes.length} scene · videoclip WebM compus local${spec.scenes.some(scene => scene.image) ? " cu imagini AI" : " cu fundaluri animate"}`;
    const images = document.createElement("button"); images.className = "btn small"; images.textContent = "Generează imagini pentru scene";
    images.addEventListener("click", async () => {
      if (!confirm(`Se va genera câte o imagine AI pentru ${spec.scenes.length} scene. Furnizorul API poate taxa fiecare imagine. Continui?`)) return;
      images.disabled = true;
      const gallery = document.createElement("div"); gallery.className = "creative-output"; output.replaceChildren(gallery);
      try {
        for (let i = 0; i < spec.scenes.length; i++) {
          detail.textContent = `Se generează imaginea ${i + 1}/${spec.scenes.length}…`;
          const scene = spec.scenes[i];
          if (!scene.image) {
            const result = await api("/api/media/image", jsonBody({ prompt: `${scene.text}. Cinematic storyboard frame, expressive composition, no text, no letters.` }));
            scene.image = result.dataUrl;
          }
          const img = document.createElement("img"); img.className = "creative-image"; img.alt = scene.text; img.src = scene.image; gallery.append(img);
        }
        detail.textContent = `${spec.scenes.length} imagini AI pregătite · următorul export include voice-over, dacă l-ai generat.`;
      } catch (error) { detail.textContent = error.message; }
      finally { images.disabled = false; }
    });
    const voice = document.createElement("button"); voice.className = "btn small"; voice.textContent = "Generează voice-over MP3";
    voice.addEventListener("click", async () => {
      voice.disabled = true; detail.textContent = "Se generează voice-over…";
      try {
        const result = await generateSpeech(spec.scenes.map(scene => scene.text).join(". "));
        spec.voiceDataUrl = result.dataUrl;
        const player = document.createElement("audio"); player.controls = true; player.src = result.dataUrl;
        const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă voice-over MP3"; link.href = result.dataUrl; link.download = safeMediaName(spec.title, "mp3");
        output.replaceChildren(player, link); detail.textContent = "Voice-over creat · exportul video îl va include ca pistă audio.";
      } catch (error) { detail.textContent = error.message; }
      finally { voice.disabled = false; }
    });
    action.textContent = "Exportă WebM";
    action.addEventListener("click", async () => { action.disabled = true; detail.textContent = "Se randează videoclipul în browser…"; try { const blob = await exportVideo(spec), url = URL.createObjectURL(blob); const player = document.createElement("video"); player.controls = true; player.src = url; const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă WebM"; link.href = url; link.download = safeMediaName(spec.title, "webm"); output.replaceChildren(player, link); detail.textContent = `WebM creat local${spec.voiceDataUrl ? " cu voice-over" : ""} · ${Math.round(blob.size / 1024)} KiB`; } catch (error) { detail.textContent = error.message; } finally { action.disabled = false; } });
    card.append(heading, detail, images, voice, action, output); node.append(card); return;
  }
  card.append(heading, detail, action, output); node.append(card);
}

function addBubble(role, content, events = []) {
  const node = document.createElement("div"); node.className = `message ${role}`;
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = role === "user" ? "Tu" : "Nova";
  const creative = role === "assistant" ? parseCreativeSpec(content) : { text: content, spec: null };
  const body = document.createElement("div"); body.textContent = creative.text;
  node.append(meta, body);
  if (creative.spec) addCreativeCard(node, creative.spec);
  if (events?.length) {
    const activity = document.createElement("div"); activity.className = "agent-events";
    activity.textContent = events.map(event => `${event.ok ? "✓" : "!"} ${event.summary}`).join("\n"); node.append(activity);
  }
  if (role === "assistant" && creative.text.trim() && state.settings?.provider === "openai") {
    const row = document.createElement("div"); row.className = "apply-row"; addSpeechButton(row, creative.text); node.append(row);
  }
  messageContainer().append(node); el("messages").scrollTop = el("messages").scrollHeight;
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
  if (!confirm(`Muți proiectul „${current.name}” în coșul local? Îl poți restaura din butonul Restaurează. Modificările nesalvate se pierd.`)) return;
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
  if (!confirm(`Muți ${state.activePath} în coșul local? Poți folosi Undo pentru a-l restaura.`)) return;
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
  if (!model) { toast("Configurează furnizorul AI și alege un model."); return; }
  setView("chat");
  const mode = el("modeSelect").value;
  const task = el("taskSelect").value;
  const allowChanges = mode === "build" && el("allowChanges").checked;
  const currentProject = state.projects.find(project => project.id === state.project);
  const activeContent = state.activePath ? el("editor").value : "";
  const contextualPrompt = `${promptText}\n\nProiect: ${currentProject?.name || state.project}\nFișier activ: ${state.activePath || "niciunul"}\nConținutul fișierului activ:\n\`\`\`${state.activePath?.split(".").pop() || "text"}\n${activeContent}\n\`\`\``;
  state.chat.push({ role: "user", content: contextualPrompt, displayContent: promptText });
  localStorage.setItem(chatKey(), JSON.stringify(state.chat));
  addBubble("user", promptText); el("prompt").value = "";
  const pending = document.createElement("div"); pending.className = "thinking"; pending.textContent = mode === "build" ? "Agentul explorează proiectul…" : mode === "plan" ? "Nova pregătește planul…" : "Nova revizuiește codul…";
  messageContainer().append(pending); el("messages").scrollTop = el("messages").scrollHeight;
  state.busy = true; el("sendBtn").disabled = true;
  try {
    if (state.dirty) await saveFile(false);
    const result = await api("/api/agent", jsonBody({ project: state.project, model, mode, task, allowChanges, messages: state.chat.map(({ role, content }) => ({ role, content })) }));
    state.chat.push({ role: "assistant", content: result.content });
    localStorage.setItem(chatKey(), JSON.stringify(state.chat));
    addBubble("assistant", result.content, result.events);
    if (result.events.some(event => event.ok && event.tool === "write_file")) {
      await refreshFiles(false);
      if (state.activePath && state.files.some(file => file.path === state.activePath)) await openFile(state.activePath, true);
      toast("Agentul a salvat modificările. Folosește Undo pentru a reveni.");
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
el("voiceComposerBtn").addEventListener("click", openVoiceDialog);
el("generateVoiceBtn").addEventListener("click", generateVoiceFromDialog);
el("voiceSettingsBtn").addEventListener("click", () => { el("voiceDialog").close(); el("providerSettingsBtn").click(); });
el("providerSettingsBtn").addEventListener("click", async () => {
  try { await loadProviderSettings(); el("providerDialog").showModal(); }
  catch (error) { toast(error.message); }
});
el("providerSelect").addEventListener("change", event => { el("openAiFields").hidden = event.target.value !== "openai"; });
el("saveProviderSettings").addEventListener("click", () => saveProviderSettings().catch(error => toast(error.message)));
el("taskSelect").addEventListener("change", event => {
  setTask(event.target.value);
});
document.querySelectorAll(".create-item, .mode-chip").forEach(button => button.addEventListener("click", () => {
  setTask(button.dataset.task);
  setView("chat");
  el("prompt").focus();
}));
document.querySelectorAll(".global-nav-link[data-view]").forEach(button => button.addEventListener("click", () => {
  const view = button.dataset.view;
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
el("projectDrawer").addEventListener("toggle", event => {
  const open = event.currentTarget.open;
  el("app").classList.toggle("projects-open", open);
  el("projectsNavBtn").setAttribute("aria-expanded", String(open));
  el("projectsNavBtn").classList.toggle("active", open);
});
el("app").addEventListener("click", event => {
  if (event.target === el("app") && el("app").classList.contains("projects-open")) setProjectsOpen(false);
});
el("seeProjectsBtn").addEventListener("click", () => setProjectsOpen(true));
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
  el("prompt").value = value; el("homePrompt").value = ""; resizePrompt(); setView("chat"); send();
}
el("homeSendBtn").addEventListener("click", submitHomePrompt);
el("homePrompt").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitHomePrompt(); }
});
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
  if (["chat", "code", "lyrics", "music", "video"].includes(action)) {
    const task = action === "chat" ? "auto" : action;
    setTask(task); if (draft) { el("prompt").value = draft; el("homePrompt").value = ""; resizePrompt(); }
    setView("chat"); el("prompt").focus(); return;
  }
  if (action === "image") {
    if (!draft) { setView("chat"); el("prompt").placeholder = "Descrie imaginea pe care vrei s-o creezi…"; el("prompt").focus(); return; }
    el("prompt").value = draft; el("homePrompt").value = ""; await generateImageFromPrompt(); return;
  }
});
el("prompt").addEventListener("input", resizePrompt);
el("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } });
el("refreshModels").addEventListener("click", refreshHealth);
el("refreshModelsTop").addEventListener("click", refreshHealth);
el("newProjectBtn").addEventListener("click", createProject);
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

loadAccount().then(() => Promise.all([loadProviderSettings(), loadProjects()])).catch(error => {
  el("projectName").textContent = "Server indisponibil"; toast(error.message);
}).then(() => {
  if (state.account?.role === "owner" && new URLSearchParams(location.search).get("settings") === "ai") {
    const url = new URL(location.href); url.searchParams.delete("settings"); history.replaceState(null, "", url);
    el("providerSettingsBtn").click();
  }
});


