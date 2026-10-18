const el = id => document.getElementById(id);
const state = { projects: [], project: null, files: [], activePath: null, dirty: false, chat: [], busy: false, filter: "" };
const fileIcons = { js: "JS", mjs: "JS", cjs: "JS", ts: "TS", py: "PY", md: "MD", css: "{}", html: "<>", json: "{}", gpc: "GPC" };

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Cererea a eșuat (${response.status}).`);
  return data;
}
function jsonBody(value) { return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }; }
function toast(text) { const node = el("toast"); node.textContent = text; node.classList.add("show"); setTimeout(() => node.classList.remove("show"), 2200); }
function iconFor(name) { return fileIcons[name.split(".").pop().toLowerCase()] || "·"; }
function activeKey(project = state.project) { return `nova-active-file-${project}`; }
function chatKey(project = state.project) { return `nova-chat-${project}`; }

async function refreshHealth() {
  const badge = el("statusBadge"), dot = el("connectionDot"), label = el("connectionText"), select = el("modelSelect");
  try {
    const data = await api("/api/health");
    if (!data.connected) throw new Error(data.error || "Ollama nu este disponibil");
    dot.classList.add("on"); label.textContent = `Ollama ${data.version}`; badge.textContent = "Ollama conectat";
    badge.style.color = "var(--green)"; badge.style.borderColor = "#364131";
    const previous = select.value; select.replaceChildren();
    if (!data.models.length) select.add(new Option("Niciun model instalat", ""));
    else { data.models.forEach(model => select.add(new Option(model, model))); if (data.models.includes(previous)) select.value = previous; }
  } catch (error) {
    dot.classList.remove("on"); label.textContent = "Ollama deconectat"; badge.textContent = "Ollama indisponibil";
    badge.style.color = "#e4a69b"; badge.style.borderColor = "#583b35";
    select.replaceChildren(new Option("Pornește Ollama și reîncarcă", ""));
  }
}

function renderProjects() {
  const select = el("projectSelect"); select.replaceChildren();
  for (const project of state.projects) select.add(new Option(project.name, project.id));
  if (state.project) select.value = state.project;
  const current = state.projects.find(project => project.id === state.project);
  el("projectName").textContent = current?.name || "Niciun proiect";
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
  const box = el("messages"); box.replaceChildren();
  if (!state.chat.length) {
    const welcome = document.createElement("div"); welcome.className = "welcome"; welcome.id = "welcome";
    welcome.innerHTML = `<div class="welcome-mark">N</div><h1>Ce creăm azi?</h1><p>Scrie cod pentru Windows/PC, versuri originale, compoziții și scenarii video în aceeași conversație. Scrierea fișierelor cere permisiunea ta.</p><div class="suggestions"><button class="suggestion" data-task="code">Creează o aplicație Windows pentru lista mea de sarcini</button><button class="suggestion" data-task="lyrics">Scrie versuri pop despre un nou început</button><button class="suggestion" data-task="music">Compune o piesă lo-fi: tempo, acorduri și structură</button><button class="suggestion" data-task="video">Scrie un videoclip de 30 de secunde cu storyboard și voice-over</button></div>`;
    box.append(welcome);
    welcome.querySelectorAll(".suggestion").forEach(button => button.addEventListener("click", () => { el("taskSelect").value = button.dataset.task || "auto"; el("prompt").value = button.textContent; el("prompt").focus(); }));
    return;
  }
  for (const message of state.chat) addBubble(message.role, message.content, message.events);
  box.scrollTop = box.scrollHeight;
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
  ctx.fillStyle = scene.background; ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width * 0.76, height * 0.16, 2, width * 0.76, height * 0.16, width * 0.8);
  glow.addColorStop(0, "rgba(255,255,255,.13)"); glow.addColorStop(1, "rgba(0,0,0,.3)"); ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
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
  const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d"), stream = canvas.captureStream(24);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error("Browserul nu oferă un format WebM compatibil.");
  const chunks = [], recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
  const stopped = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = () => reject(new Error("Exportul video a eșuat.")); });
  const total = Math.min(60, spec.scenes.reduce((sum, scene) => sum + scene.seconds, 0));
  drawVideoFrame(ctx, spec, 0, canvas.width, canvas.height);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.start(250);
  await new Promise(resolve => { const start = performance.now(); const frame = now => { const elapsed = (now - start) / 1000; drawVideoFrame(ctx, spec, elapsed, canvas.width, canvas.height); if (elapsed >= total) { recorder.stop(); resolve(); } else requestAnimationFrame(frame); }; requestAnimationFrame(frame); });
  await stopped; stream.getTracks().forEach(track => track.stop());
  return new Blob(chunks, { type: mime });
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
    detail.textContent = `${spec.scenes.length} scene · video tipografic WebM`;
    action.textContent = "Exportă WebM";
    action.addEventListener("click", async () => { action.disabled = true; detail.textContent = "Se randează videoclipul în browser…"; try { const blob = await exportVideo(spec), url = URL.createObjectURL(blob); const player = document.createElement("video"); player.controls = true; player.src = url; const link = document.createElement("a"); link.className = "btn small"; link.textContent = "Descarcă WebM"; link.href = url; link.download = safeMediaName(spec.title, "webm"); output.replaceChildren(player, link); detail.textContent = `WebM creat local · ${Math.round(blob.size / 1024)} KiB`; } catch (error) { detail.textContent = error.message; } finally { action.disabled = false; } });
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
  el("messages").append(node); el("messages").scrollTop = el("messages").scrollHeight;
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
  renderFiles();
  if (state.activePath) await openFile(state.activePath, true);
}

async function loadProjects() {
  const data = await api("/api/projects"); state.projects = data.projects;
  if (!state.projects.length) {
    const created = await api("/api/projects", jsonBody({ name: "Nova Playground" }));
    state.projects = [created.project];
  }
  const remembered = localStorage.getItem("nova-project");
  const selected = state.projects.find(project => project.id === remembered) || state.projects[0];
  state.project = selected.id; localStorage.setItem("nova-project", selected.id); renderProjects(); await loadProject(selected.id);
}

async function createProject() {
  const name = prompt("Numele proiectului nou:"); if (!name?.trim()) return;
  try {
    const data = await api("/api/projects", jsonBody({ name: name.trim() }));
    state.projects.push(data.project); state.dirty = false; await loadProject(data.project.id); localStorage.setItem("nova-project", data.project.id); toast("Proiect creat");
  } catch (error) { toast(error.message); }
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
    else { state.project = state.projects[0].id; localStorage.setItem("nova-project", state.project); renderProjects(); await loadProject(state.project); }
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
    localStorage.setItem("nova-project", project.id); renderProjects(); await loadProject(project.id); toast("Proiect restaurat");
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
    localStorage.setItem("nova-project", state.project); renderProjects(); await loadProject(state.project);
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
  if (!model) { toast("Alege un model Ollama instalat."); return; }
  const mode = el("modeSelect").value;
  const task = el("taskSelect").value;
  const allowChanges = mode === "build" && el("allowChanges").checked;
  const currentProject = state.projects.find(project => project.id === state.project);
  const activeContent = state.activePath ? el("editor").value : "";
  const contextualPrompt = `${promptText}\n\nProiect: ${currentProject?.name || state.project}\nFișier activ: ${state.activePath || "niciunul"}\nConținutul fișierului activ:\n\`\`\`${state.activePath?.split(".").pop() || "text"}\n${activeContent}\n\`\`\``;
  state.chat.push({ role: "user", content: contextualPrompt });
  localStorage.setItem(chatKey(), JSON.stringify(state.chat));
  addBubble("user", promptText); el("prompt").value = "";
  const pending = document.createElement("div"); pending.className = "thinking"; pending.textContent = mode === "build" ? "Agentul explorează proiectul…" : mode === "plan" ? "Nova pregătește planul…" : "Nova revizuiește codul…";
  el("messages").append(pending); el("messages").scrollTop = el("messages").scrollHeight;
  state.busy = true; el("sendBtn").disabled = true;
  try {
    if (state.dirty) await saveFile(false);
    const result = await api("/api/agent", jsonBody({ project: state.project, model, mode, task, allowChanges, messages: state.chat }));
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
el("taskSelect").addEventListener("change", event => {
  const prompts = {
    auto: "Cere cod, versuri, o compoziție sau un scenariu video… (Enter trimite)",
    code: "Descrie aplicația sau unealta pentru Windows/PC… (Enter trimite)",
    lyrics: "Descrie tema, genul și tonul versurilor… (Enter trimite)",
    music: "Descrie genul și atmosfera compoziției… (Enter trimite)",
    video: "Descrie ideea, publicul și durata videoclipului… (Enter trimite)"
  };
  el("prompt").placeholder = prompts[event.target.value] || prompts.auto;
});
el("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } });
el("refreshModels").addEventListener("click", refreshHealth);
el("refreshModelsTop").addEventListener("click", refreshHealth);
el("newProjectBtn").addEventListener("click", createProject);
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
el("projectSelect").addEventListener("change", async event => { try { await loadProject(event.target.value); localStorage.setItem("nova-project", event.target.value); } catch (error) { toast(error.message); } });
el("clearChat").addEventListener("click", () => { state.chat = []; localStorage.setItem(chatKey(), "[]"); renderChat(); });
el("copyBtn").addEventListener("click", async () => { try { await navigator.clipboard.writeText(el("editor").value); toast("Cod copiat"); } catch { toast("Clipboard indisponibil în acest context"); } });
el("downloadBtn").addEventListener("click", () => {
  const blob = new Blob([el("editor").value], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = state.activePath?.split("/").pop() || "nova.txt"; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
window.addEventListener("beforeunload", event => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });

Promise.all([refreshHealth(), loadProjects()]).catch(error => {
  el("projectName").textContent = "Server indisponibil"; toast(error.message);
});

