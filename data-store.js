"use strict";

const nativeFs = require("node:fs");
const path = require("node:path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const DUAL_WRITE_TO_DISK = process.env.NOVA_STORAGE_DUAL_WRITE === "true";
const LOCK_ID = 741230119;
let pool = null;
let dataRoot = "";

function dataRelative(value) {
  const absolute = path.resolve(String(value));
  if (absolute !== dataRoot && !absolute.startsWith(dataRoot + path.sep)) return null;
  const relative = path.relative(dataRoot, absolute).split(path.sep).join("/");
  return relative;
}

function makeError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function stats(row) {
  const directory = row.kind === "dir";
  const modified = row.modified_at instanceof Date ? row.modified_at : new Date(row.modified_at);
  const size = directory ? 0 : Buffer.from(row.content || []).length;
  return {
    size,
    mtime: modified,
    mtimeMs: modified.getTime(),
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false
  };
}

function dirent(name, kind) {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false
  };
}

async function ensureDatabaseDirectory(client, filePath) {
  const segments = filePath.split("/").filter(Boolean).slice(0, -1);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    await client.query(
      `INSERT INTO nova_files (file_path, kind, content, modified_at)
       VALUES ($1, 'dir', ''::bytea, now()) ON CONFLICT (file_path) DO NOTHING`,
      [current]
    );
  }
}

async function importDiskData(client) {
  const marker = await client.query("SELECT value FROM nova_meta WHERE key = 'disk_import_v1'");
  if (marker.rowCount) return;

  await client.query("BEGIN");
  try {
    const root = dataRoot;
    async function visit(absolute, relative = "") {
      let entries;
      try { entries = await nativeFs.promises.readdir(absolute, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = path.join(absolute, entry.name);
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await client.query(
            `INSERT INTO nova_files (file_path, kind, content, modified_at)
             VALUES ($1, 'dir', ''::bytea, now()) ON CONFLICT (file_path) DO NOTHING`,
            [name]
          );
          await visit(child, name);
        } else if (entry.isFile()) {
          const content = await nativeFs.promises.readFile(child);
          const stat = await nativeFs.promises.stat(child);
          await client.query(
            `INSERT INTO nova_files (file_path, kind, content, modified_at)
             VALUES ($1, 'file', $2, $3) ON CONFLICT (file_path) DO NOTHING`,
            [name, content, stat.mtime]
          );
        }
      }
    }
    await visit(root);
    await client.query(
      "INSERT INTO nova_meta (key, value) VALUES ('disk_import_v1', jsonb_build_object('completedAt', now())) ON CONFLICT (key) DO NOTHING"
    );
    await client.query("COMMIT");
    console.log("Nova storage: existing disk data imported to PostgreSQL.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function init(root) {
  dataRoot = path.resolve(root);
  if (!DATABASE_URL) return;
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  pool.on("error", error => console.error("Nova PostgreSQL idle connection failed:", error.message));
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nova_files (
      file_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('dir', 'file')),
      content BYTEA NOT NULL DEFAULT ''::bytea,
      modified_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS nova_sessions (
      token TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nova_sessions_expiry_idx ON nova_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS nova_settings (
      setting_key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS nova_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await importDiskData(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function withLock(operation) {
  if (!pool) return operation();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    return await operation();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function getSession(token) {
  if (!pool) return null;
  const result = await pool.query("SELECT payload, expires_at FROM nova_sessions WHERE token = $1", [token]);
  if (!result.rowCount) return null;
  if (new Date(result.rows[0].expires_at).getTime() <= Date.now()) {
    await pool.query("DELETE FROM nova_sessions WHERE token = $1", [token]);
    return null;
  }
  return { ...result.rows[0].payload, expiresAt: new Date(result.rows[0].expires_at).getTime() };
}

async function createSession(token, payload, expiresAt, maxSessions = 1000) {
  if (!pool) return true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID + 1]);
    await client.query("DELETE FROM nova_sessions WHERE expires_at <= now()");
    const count = await client.query("SELECT count(*)::integer AS count FROM nova_sessions");
    if (count.rows[0].count >= maxSessions) { await client.query("ROLLBACK"); return false; }
    await client.query("INSERT INTO nova_sessions (token, payload, expires_at) VALUES ($1, $2, $3)", [token, payload, new Date(expiresAt)]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function deleteSession(token) {
  if (pool) await pool.query("DELETE FROM nova_sessions WHERE token = $1", [token]);
}

async function getSetting(key) {
  if (!pool) return null;
  const result = await pool.query("SELECT value FROM nova_settings WHERE setting_key = $1", [key]);
  return result.rowCount ? result.rows[0].value : null;
}

async function setSetting(key, value) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO nova_settings (setting_key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

async function healthCheck() {
  if (!pool) return true;
  await pool.query("SELECT 1");
  return true;
}

async function close() { if (pool) await pool.end(); }

async function queryOne(filePath) {
  const relative = dataRelative(filePath);
  if (relative === null) return null;
  const result = await pool.query("SELECT file_path, kind, content, modified_at FROM nova_files WHERE file_path = $1", [relative]);
  return result.rowCount ? result.rows[0] : null;
}

const dbPromises = {
  async readFile(filePath, options) {
    const row = await queryOne(filePath);
    if (!row || row.kind !== "file") throw makeError("ENOENT", `No such file: ${filePath}`);
    const bytes = Buffer.from(row.content);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  },
  async writeFile(filePath, value, options) {
    const relative = dataRelative(filePath);
    if (relative === null || !relative) throw makeError("EINVAL", "Invalid persistent file path");
    const opts = typeof options === "string" ? { encoding: options } : (options || {});
    if (String(opts.flag || "").includes("x")) {
      const existing = await queryOne(filePath);
      if (existing) throw makeError("EEXIST", `File already exists: ${filePath}`);
    }
    const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value), opts.encoding || "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ensureDatabaseDirectory(client, relative);
      await client.query(
        `INSERT INTO nova_files (file_path, kind, content, modified_at) VALUES ($1, 'file', $2, now())
         ON CONFLICT (file_path) DO UPDATE SET kind = 'file', content = EXCLUDED.content, modified_at = now()`,
        [relative, content]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  },
  async mkdir(dirPath, options = {}) {
    const relative = dataRelative(dirPath);
    if (relative === null) return nativeFs.promises.mkdir(dirPath, options);
    const pieces = relative.split("/").filter(Boolean);
    const paths = [];
    let current = "";
    for (const piece of pieces) { current = current ? `${current}/${piece}` : piece; paths.push(current); }
    if (!pieces.length) return dirPath;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < paths.length; i++) {
        const existing = await client.query("SELECT kind FROM nova_files WHERE file_path = $1", [paths[i]]);
        if (existing.rowCount && existing.rows[0].kind !== "dir") throw makeError("ENOTDIR", `Not a directory: ${paths[i]}`);
        if (existing.rowCount && !options.recursive && i === paths.length - 1) throw makeError("EEXIST", `Directory exists: ${paths[i]}`);
        if (!existing.rowCount) {
          if (!options.recursive && i !== paths.length - 1) throw makeError("ENOENT", `Missing parent directory: ${paths[i]}`);
          await client.query("INSERT INTO nova_files (file_path, kind, content, modified_at) VALUES ($1, 'dir', ''::bytea, now())", [paths[i]]);
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
    return dirPath;
  },
  async readdir(dirPath, options = {}) {
    const relative = dataRelative(dirPath);
    if (relative === null) return nativeFs.promises.readdir(dirPath, options);
    const parent = relative ? `${relative}/` : "";
    const result = await pool.query("SELECT file_path, kind FROM nova_files WHERE left(file_path, length($1)) = $1 AND file_path <> $2", [parent, relative]);
    const items = new Map();
    for (const row of result.rows) {
      const rest = row.file_path.slice(parent.length);
      if (!rest || rest.includes("/")) continue;
      items.set(rest, row.kind);
    }
    if (!items.size && relative) {
      const dir = await queryOne(dirPath);
      if (!dir || dir.kind !== "dir") throw makeError("ENOENT", `No such directory: ${dirPath}`);
    }
    const names = [...items.keys()].sort();
    return options?.withFileTypes ? names.map(name => dirent(name, items.get(name))) : names;
  },
  async lstat(filePath) {
    const row = await queryOne(filePath);
    if (!row) throw makeError("ENOENT", `No such path: ${filePath}`);
    return stats(row);
  },
  async stat(filePath) { return this.lstat(filePath); },
  async realpath(filePath) {
    const relative = dataRelative(filePath);
    if (relative === null) return nativeFs.promises.realpath(filePath);
    const row = await queryOne(filePath);
    if (!row) throw makeError("ENOENT", `No such path: ${filePath}`);
    return path.resolve(filePath);
  },
  async rename(fromPath, toPath) {
    const from = dataRelative(fromPath), to = dataRelative(toPath);
    if (from === null || to === null || !from || !to) throw makeError("EINVAL", "Invalid persistent rename path");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ensureDatabaseDirectory(client, to);
      const source = await client.query(
        "SELECT file_path, kind, content, modified_at FROM nova_files WHERE file_path = $1 OR left(file_path, length($2)) = $2 ORDER BY length(file_path)",
        [from, `${from}/`]
      );
      if (!source.rowCount) throw makeError("ENOENT", `No such path: ${fromPath}`);
      const dest = await client.query("SELECT kind FROM nova_files WHERE file_path = $1", [to]);
      if (dest.rowCount) {
        // fs.rename replaces an existing file on Render's Linux runtime. Account
        // updates use a temporary file followed by rename, so refusing to replace
        // the existing JSON file makes registration and quota updates fail.
        if (source.rowCount !== 1 || source.rows[0].kind !== "file" || dest.rows[0].kind !== "file") {
          throw makeError("EEXIST", `Destination exists: ${toPath}`);
        }
        await client.query("DELETE FROM nova_files WHERE file_path = $1", [to]);
      }
      for (const row of source.rows) {
        const suffix = row.file_path === from ? "" : row.file_path.slice(from.length);
        const newPath = `${to}${suffix}`;
        await client.query(
          "INSERT INTO nova_files (file_path, kind, content, modified_at) VALUES ($1, $2, $3, $4)",
          [newPath, row.kind, row.content, row.modified_at]
        );
      }
      await client.query("DELETE FROM nova_files WHERE file_path = $1 OR left(file_path, length($2)) = $2", [from, `${from}/`]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  },
  async unlink(filePath) {
    const relative = dataRelative(filePath);
    if (relative === null || !relative) throw makeError("EINVAL", "Invalid persistent file path");
    const result = await pool.query("DELETE FROM nova_files WHERE file_path = $1 AND kind = 'file'", [relative]);
    if (!result.rowCount) throw makeError("ENOENT", `No such file: ${filePath}`);
  },
  async copyFile(fromPath, toPath) {
    const data = await this.readFile(fromPath);
    await this.writeFile(toPath, data);
  }
};

function filesystem(root) {
  dataRoot = path.resolve(root);
  if (!pool) return nativeFs;
  if (!DUAL_WRITE_TO_DISK) return { ...nativeFs, promises: dbPromises };
  const mirroredMethods = new Set(["writeFile", "mkdir", "rename", "unlink", "copyFile"]);
  const promises = new Proxy(dbPromises, {
    get(target, property) {
      const operation = target[property];
      if (typeof operation !== "function") return operation;
      if (!mirroredMethods.has(property)) return operation.bind(target);
      return async (...args) => {
        const result = await operation.apply(target, args);
        try { await nativeFs.promises[property](...args); }
        catch (error) {
          console.error(`Nova disk mirror failed during ${String(property)}; PostgreSQL remains authoritative:`, error.message);
        }
        return result;
      };
    }
  });
  return { ...nativeFs, promises };
}

module.exports = {
  init,
  filesystem,
  withLock,
  getSession,
  createSession,
  deleteSession,
  getSetting,
  setSetting,
  healthCheck,
  close,
  get enabled() { return Boolean(pool); }
};

