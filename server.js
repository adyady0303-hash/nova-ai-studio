const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const PUBLIC_DIR = path.join(__dirname, "public");
const PROJECTS_DIR = path.join(__dirname, "projects");
const BACKUPS_DIR = path.join(__dirname, "data", "backups");
const PROJECT_TRASH_DIR = path.join(__dirname, "data", "project-trash");
const MAX_BODY = 1024 * 1024;
const MAX_FILE = 512 * 1024;

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
fs.mkdirSync(PROJECT_TRASH_DIR, { recursive: true });

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

function readJson(req) {
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Corpul cererii nu este JSON valid."), { status: 400 }));
      }
    });
    req.on("error", error => { if (!settled) reject(error); });
  });
}

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

function validProjectId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function projectRoot(project) {
  if (!validProjectId(project)) throw Object.assign(new Error("Proiect invalid."), { status: 400 });
  const root = path.resolve(PROJECTS_DIR, project);
  if (!root.startsWith(`${PROJECTS_DIR}${path.sep}`)) throw Object.assign(new Error("Cale de proiect invalidă."), { status: 400 });
  return root;
}

async function assertProjectParent(target) {
  const rootStat = await fs.promises.lstat(target.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("Proiectul nu este un dosar local obișnuit."), { status: 403 });
  const rootReal = await fs.promises.realpath(target.root);
  const parentReal = await fs.promises.realpath(path.dirname(target.full));
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) throw Object.assign(new Error("Calea nu poate ieși din proiectul deschis."), { status: 403 });
}

function projectFile(project, name) {
  if (typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Numele fișierului lipsește."), { status: 400 });
  const portable = name.replace(/\\/g, "/");
  if (portable.startsWith("/") || portable.split("/").some(part => !part || part === "." || part === ".." || [".nova-backups", ".nova-project.json", ".git", "node_modules"].includes(part))) {
    throw Object.assign(new Error("Calea fișierului nu este permisă."), { status: 400 });
  }
  const root = projectRoot(project);
  const full = path.resolve(root, ...portable.split("/"));
  if (!full.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("Calea fișierului nu este permisă."), { status: 400 });
  return { root, full, relative: portable };
}

async function listProjectFiles(root) {
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("Proiectul nu este un dosar local obișnuit."), { status: 404 });
  const out = [];
  async function visit(folder, relative = "") {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".nova-backups" || entry.name === ".nova-project.json") continue;
      const abs = path.join(folder, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(abs);
        out.push({ path: rel, size: stat.size, modified: stat.mtime.toISOString() });
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function readProjectFile(project, name) {
  const target = projectFile(project, name);
  await assertProjectParent(target);
  const stat = await fs.promises.lstat(target.full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("Fișierul nu există sau nu este un fișier obișnuit."), { status: 404 });
  if (stat.size > MAX_FILE) throw Object.assign(new Error("Fișierul depășește limita de 512 KiB."), { status: 413 });
  return await fs.promises.readFile(target.full, "utf8");
}

async function writeProjectFile(project, name, content) {
  if (typeof content !== "string") throw Object.assign(new Error("Conținutul fișierului trebuie să fie text."), { status: 400 });
  if (Buffer.byteLength(content, "utf8") > MAX_FILE) throw Object.assign(new Error("Fișierul depășește limita de 512 KiB."), { status: 413 });
  const target = projectFile(project, name);
  await fs.promises.mkdir(path.dirname(target.full), { recursive: true });
  await assertProjectParent(target);
  let existed = false;
  try {
    const stat = await fs.promises.lstat(target.full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("Ținta nu este un fișier obișnuit."), { status: 400 });
    existed = true;
    const backupFile = path.join(BACKUPS_DIR, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bak`;
    await fs.promises.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.promises.copyFile(target.full, backupFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!existed) {
    const marker = path.join(BACKUPS_DIR, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.created`;
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, "", "utf8");
  }
  await fs.promises.writeFile(target.full, content, "utf8");
  return { path: target.relative, action: existed ? "updated" : "created" };
}

const agentTools = [
  { type: "function", function: { name: "list_files", description: "List the files in the open project.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 text file from the open project.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Project-relative path, such as src/index.js" } }, additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or update a UTF-8 text file in the open project. Only call this when the user asked to implement changes.", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string", description: "Project-relative file path" }, content: { type: "string", description: "Complete UTF-8 file content" } }, additionalProperties: false } } }
];

async function callAgentTool(name, args, project, allowChanges) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Argumente de unealtă invalide.");
  if (name === "list_files") return JSON.stringify(await listProjectFiles(projectRoot(project)));
  if (name === "read_file") return await readProjectFile(project, args.path);
  if (name === "write_file") {
    if (!allowChanges) throw new Error("Scrierea este dezactivată. Activează «Permite modificări» pentru agent.");
    const result = await writeProjectFile(project, args.path, args.content);
    return `Fișier ${result.action}: ${result.path}. O copie anterioară a fost salvată pentru anulare.`;
  }
  throw new Error(`Unealtă necunoscută: ${name}`);
}

async function runAgent(model, inputMessages, project, mode, allowChanges, task = "auto") {
  const taskPrompts = {
    auto: "Detectează intenția utilizatorului. Pentru cod, construiește sau explică proiecte pentru Windows și PC. Pentru versuri, scrie versuri originale complete și potrivite cererii. Pentru muzică, creează o compoziție descrisă clar: gen, tempo, tonalitate, acorduri, structură și instrumentație. Pentru video, creează concept, scenariu, cadre, narațiune și subtitrări. Poți salva texte, specificații și cod în proiect dacă scrierea este permisă.",
    code: "Construiește aplicații și unelte pentru PC, cu prioritate pentru Windows 10/11. Oferă fișiere complete, instrucțiuni de instalare și dependențe; explorează proiectul înainte să scrii.",
    lyrics: "Scrie versuri originale în limba utilizatorului, cu titlu și secțiuni clare (strofe, refren, punte). Respectă tema, genul, tonul și lungimea cerute. Nu imita versurile sau stilul exact al unui artist în viață; descrie trăsături muzicale generale. Dacă utilizatorul cere, salvează versurile într-un fișier text.",
    music: "Creează un plan de compoziție original și practic: gen, tempo, măsură, tonalitate, progresie de acorduri, structură, instrumentație și indicații de interpretare. Poți scrie cod sau date pentru unelte de compoziție în proiect. Nu pretinde că ai produs ori redat un fișier audio: nu ai motor de generare sau export audio.",
    video: "Creează un concept video original și practic: logline, scenariu, listă de cadre cu durată, voice-over, subtitrări, indicații de montaj și sunet. Poți scrie cod sau proiecte pentru unelte video în dosarul proiectului. Nu pretinde că ai randat ori exportat un fișier video: nu ai motor de generare sau export video."
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
  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    const response = await ollamaJson("/api/chat", {
      method: "POST",
      body: JSON.stringify({ model, stream: false, messages, tools, options: { temperature: 0.2 } })
    });
    const message = response.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push(message);
    if (!calls.length) return { content: message.content || "Agentul a terminat fără un răspuns text.", events, model: response.model || model };
    for (const call of calls) {
      const name = call.function?.name;
      try {
      let args = call.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
      const result = await callAgentTool(name, args, project, allowChanges);
        events.push({ tool: name, ok: true, summary: name === "write_file" ? result : name === "list_files" ? "Lista de fișiere citită" : `Fișier citit: ${args.path}` });
        messages.push({ role: "tool", tool_name: name, content: String(result).slice(0, 30000) });
      } catch (error) {
        events.push({ tool: name || "unknown", ok: false, summary: error.message });
        messages.push({ role: "tool", tool_name: name || "unknown", content: `Eroare: ${error.message}` });
      }
    }
  }
  return { content: "Am atins limita de pași a agentului. Verifică schimbările efectuate și trimite o cerere de continuare dacă mai este nevoie.", events, model };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = [];
    for (const entry of await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validProjectId(entry.name)) continue;
      let name = entry.name;
      try { name = JSON.parse(await fs.promises.readFile(path.join(PROJECTS_DIR, entry.name, ".nova-project.json"), "utf8")).name || name; } catch {}
      projects.push({ id: entry.name, name });
    }
    return json(res, 200, { projects: projects.sort((a, b) => a.name.localeCompare(b.name)) });
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(req);
    const originalName = typeof body.name === "string" ? body.name.trim() : "";
    if (!originalName || originalName.length > 80) return json(res, 400, { error: "Numele proiectului trebuie să aibă între 1 și 80 de caractere." });
    const slug = originalName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "proiect";
    let id = slug;
    while (fs.existsSync(path.join(PROJECTS_DIR, id)) || (await fs.promises.readdir(PROJECT_TRASH_DIR)).some(name => name.startsWith(`${id}.`))) id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const root = projectRoot(id);
    await fs.promises.mkdir(path.join(root, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(root, ".nova-project.json"), JSON.stringify({ name: originalName }, null, 2), "utf8");
    if (body.empty !== true) {
      await fs.promises.writeFile(path.join(root, "README.md"), `# ${originalName}\n\nProiect creat în Nova AI Studio.\n`, "utf8");
      await fs.promises.writeFile(path.join(root, "src", "index.js"), `// Începe să construiești ${originalName}.\n\nfunction main() {\n  console.log("Salut, Nova!");\n}\n\nmain();\n`, "utf8");
      await fs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ name: id, version: "0.1.0", private: true }, null, 2) + "\n", "utf8");
    }
    return json(res, 201, { project: { id, name: originalName } });
  }

  if (req.method === "POST" && url.pathname === "/api/project/rename") {
    const body = await readJson(req);
    const root = projectRoot(body.project);
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return json(res, 400, { error: "Numele trebuie să aibă între 1 și 80 de caractere." });
    await fs.promises.writeFile(path.join(root, ".nova-project.json"), JSON.stringify({ name: body.name.trim() }, null, 2), "utf8");
    return json(res, 200, { id: body.project, name: body.name.trim() });
  }

  if (req.method === "POST" && url.pathname === "/api/project/delete") {
    const body = await readJson(req);
    const root = projectRoot(body.project);
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return json(res, 400, { error: "Proiectul nu este un dosar local obișnuit." });
    const trashed = path.join(PROJECT_TRASH_DIR, `${body.project}.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.deleted`);
    await fs.promises.rename(root, trashed);
    return json(res, 200, { id: body.project, deleted: true });
  }

  if (req.method === "GET" && url.pathname === "/api/projects/trash") {
    const projects = [];
    for (const entry of await fs.promises.readdir(PROJECT_TRASH_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^([a-z0-9][a-z0-9-]{0,63})\.(\d+-[a-z0-9]+)\.deleted$/);
      if (!match) continue;
      let name = match[1];
      try { name = JSON.parse(await fs.promises.readFile(path.join(PROJECT_TRASH_DIR, entry.name, ".nova-project.json"), "utf8")).name || name; } catch {}
      projects.push({ id: match[1], name, trashed: entry.name });
    }
    return json(res, 200, { projects: projects.sort((a, b) => b.trashed.localeCompare(a.trashed)) });
  }

  if (req.method === "POST" && url.pathname === "/api/project/restore") {
    const body = await readJson(req);
    if (!validProjectId(body.project)) return json(res, 400, { error: "Proiect invalid." });
    const root = projectRoot(body.project);
    if (fs.existsSync(root)) return json(res, 409, { error: "Există deja un proiect cu acest identificator." });
    const prefix = `${body.project}.`;
    const entries = (await fs.promises.readdir(PROJECT_TRASH_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix) && entry.name.endsWith(".deleted"))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (!entries.length) return json(res, 404, { error: "Nu există un proiect șters care poate fi restaurat." });
    await fs.promises.rename(path.join(PROJECT_TRASH_DIR, entries[0].name), root);
    return json(res, 200, { id: body.project, restored: true });
  }

  if (req.method === "GET" && url.pathname === "/api/project/export") {
    const project = url.searchParams.get("project");
    const root = projectRoot(project);
    const files = await listProjectFiles(root);
    let total = 0;
    const contents = [];
    for (const file of files) {
      const content = await readProjectFile(project, file.path);
      total += Buffer.byteLength(content, "utf8");
      if (total > 8 * 1024 * 1024) return json(res, 413, { error: "Exportul depășește limita de 8 MiB." });
      contents.push({ path: file.path, content });
    }
    let name = project;
    try { name = JSON.parse(await fs.promises.readFile(path.join(root, ".nova-project.json"), "utf8")).name || name; } catch {}
    return json(res, 200, { format: "nova-project", version: 1, name, files: contents });
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    const project = url.searchParams.get("project");
    const files = await listProjectFiles(projectRoot(project));
    return json(res, 200, { files });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const project = url.searchParams.get("project");
    const name = url.searchParams.get("path");
    const content = await readProjectFile(project, name);
    return json(res, 200, { path: name, content });
  }

  if (req.method === "PUT" && url.pathname === "/api/file") {
    const body = await readJson(req);
    const result = await writeProjectFile(body.project, body.path, body.content);
    return json(res, 200, result);
  }

  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const project = url.searchParams.get("project");
    const name = url.searchParams.get("path");
    const target = projectFile(project, name);
    await assertProjectParent(target);
    const stat = await fs.promises.lstat(target.full);
    if (!stat.isFile() || stat.isSymbolicLink()) return json(res, 400, { error: "Poți elimina numai fișiere obișnuite." });
    const trashFile = path.join(BACKUPS_DIR, project, ...target.relative.split("/")) + `.${Date.now()}-${Math.random().toString(36).slice(2, 6)}.deleted`;
    await fs.promises.mkdir(path.dirname(trashFile), { recursive: true });
    await fs.promises.rename(target.full, trashFile);
    return json(res, 200, { path: target.relative, deleted: true });
  }

  if (req.method === "POST" && url.pathname === "/api/undo") {
    const body = await readJson(req);
    const target = projectFile(body.project, body.path);
    const backupBase = path.join(BACKUPS_DIR, body.project, ...target.relative.split("/"));
    const backupDir = path.dirname(backupBase);
    const prefix = `${path.basename(backupBase)}.`;
    let backups = [];
    try { backups = (await fs.promises.readdir(backupDir)).filter(name => name.startsWith(prefix) && /\.(bak|deleted|created)$/.test(name)).sort().reverse(); } catch {}
    if (!backups.length) return json(res, 404, { error: "Nu există o versiune anterioară pentru acest fișier." });
    const backupFile = path.join(backupDir, backups[0]);
    await fs.promises.mkdir(path.dirname(target.full), { recursive: true });
    await assertProjectParent(target);
    if (backupFile.endsWith(".created")) {
      try { await fs.promises.unlink(target.full); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.promises.unlink(backupFile);
      return json(res, 200, { path: target.relative, reverted: true });
    }
    try {
      const current = await fs.promises.lstat(target.full);
      if (current.isSymbolicLink() || !current.isFile()) throw Object.assign(new Error("Ținta nu este un fișier obișnuit."), { status: 400 });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.promises.copyFile(backupFile, target.full);
    await fs.promises.unlink(backupFile);
    return json(res, 200, { path: target.relative, restored: true });
  }

  if (req.method === "POST" && url.pathname === "/api/agent") {
    const body = await readJson(req);
    if (typeof body.model !== "string" || !body.model.trim()) return json(res, 400, { error: "Alege un model Ollama." });
    if (!validProjectId(body.project)) return json(res, 400, { error: "Alege un proiect." });
    if (!Array.isArray(body.messages) || !body.messages.length) return json(res, 400, { error: "Trimite o cerere agentului." });
    const mode = ["build", "plan", "review"].includes(body.mode) ? body.mode : "build";
    const safeMessages = body.messages.slice(-12).map(message => {
      if (!(["user", "assistant"].includes(message.role)) || typeof message.content !== "string") throw Object.assign(new Error("Format de conversație invalid."), { status: 400 });
      return { role: message.role, content: message.content.slice(0, 24000) };
    });
    const task = ["auto", "code", "lyrics", "music", "video"].includes(body.task) ? body.task : "auto";
    const result = await runAgent(body.model.trim(), safeMessages, body.project, mode, body.allowChanges === true && mode === "build", task);
    return json(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      const [version, tags] = await Promise.all([
        ollamaJson("/api/version"),
        ollamaJson("/api/tags")
      ]);
      return json(res, 200, {
        connected: true,
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

      const messages = body.messages.slice(-12).map(message => {
        if (!(["user", "assistant"].includes(message.role)) || typeof message.content !== "string") {
          throw Object.assign(new Error("Format de mesaj invalid."), { status: 400 });
        }
        return { role: message.role, content: message.content.slice(0, 24000) };
      });

      const result = await ollamaJson("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          model: body.model.trim(),
          stream: false,
          messages: [
            {
              role: "system",
              content: "Ești Nova, un asistent de programare care rulează local. Ajută la analizarea și scrierea codului. Când propui modificări, oferă blocuri de cod complete cu etichete de limbaj și numele fișierului. Nu pretinde că ai schimbat fișiere sau ai rulat comenzi; nu ai acces la sistemul de fișiere ori la terminal. Menționează clar presupunerile și riscurile relevante. Răspunde în limba utilizatorului."
            },
            ...messages
          ],
          options: { temperature: 0.25 }
        })
      });
      return json(res, 200, {
        content: result.message?.content || "Modelul nu a returnat text.",
        model: result.model || body.model,
        done: result.done === true
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
  handle(req, res).catch(error => json(res, 500, { error: error.message || "Eroare internă." }));
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

appServer.listen(PORT, HOST, () => {
  console.log(`Nova AI Studio rulează la http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA}`);
});

