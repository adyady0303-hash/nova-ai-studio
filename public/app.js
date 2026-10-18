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

function addBubble(role, content, events = []) {
  const node = document.createElement("div"); node.className = `message ${role}`;
  const meta = document.createElement("div"); meta.className = "message-meta"; meta.textContent = role === "user" ? "Tu" : "Nova";
  const body = document.createElement("div"); body.textContent = content;
  node.append(meta, body);
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

