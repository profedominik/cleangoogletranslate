// SQLite storage using Node's built-in node:sqlite (no npm dependencies).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// node:sqlite prints an ExperimentalWarning on load; silence only that one.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = await import('node:sqlite');

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    source_lang TEXT NOT NULL DEFAULT 'auto',
    target_lang TEXT NOT NULL DEFAULT 'en',
    engine TEXT NOT NULL DEFAULT 'auto',
    lines TEXT NOT NULL DEFAULT '[]',
    line_count INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0,
    translated_count INTEGER NOT NULL DEFAULT 0,
    preview TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(deleted_at, updated_at DESC);

  CREATE TABLE IF NOT EXISTS note_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    lines TEXT NOT NULL,
    line_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rev_note ON note_revisions(note_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS engines (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    in_auto INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    config TEXT NOT NULL DEFAULT '{}',
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tcache (
    key TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    sl TEXT NOT NULL,
    tl TEXT NOT NULL,
    src TEXT NOT NULL,
    out TEXT NOT NULL,
    detected TEXT,
    chars INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_hit INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tcache_lru ON tcache(last_hit);
  CREATE INDEX IF NOT EXISTS idx_tcache_engine ON tcache(engine);

  CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    engine TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    chars INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    cache_hits INTEGER NOT NULL DEFAULT 0,
    cached_chars INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, engine)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'cleantranslate.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return new Store(db, file);
}

const now = () => Date.now();
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function cacheKey(engine, sl, tl, markup, text) {
  return crypto.createHash('sha1').update(`${engine}\u0001${sl}\u0001${tl}\u0001${markup ? 1 : 0}\u0001${text}`).digest('base64url');
}

class Store {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this.stmts = new Map();
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  // ---------------------------------------------------------------- settings
  getSetting(key, dflt) {
    const r = this.q('SELECT value FROM settings WHERE key = ?').get(key);
    if (!r) return dflt;
    try { return JSON.parse(r.value); } catch { return dflt; }
  }

  setSetting(key, value) {
    this.q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  allSettings() {
    const out = {};
    for (const r of this.q('SELECT key, value FROM settings').all()) {
      try { out[r.key] = JSON.parse(r.value); } catch { /* skip corrupt */ }
    }
    return out;
  }

  // ---------------------------------------------------------------- notes
  listNotes({ q = '', limit = 200, offset = 0, trash = false } = {}) {
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const where = trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
    const rows = this.q(`SELECT id, title, source_lang, target_lang, engine, line_count, char_count, translated_count,
        preview, version, pinned, created_at, updated_at, deleted_at FROM notes
      WHERE ${where} AND (? = '' OR title LIKE ? ESCAPE '\\' OR lines LIKE ? ESCAPE '\\')
      ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`).all(q, like, like, limit, offset);
    return rows.map(noteMeta);
  }

  countNotes(trash = false) {
    return this.q(`SELECT COUNT(*) n FROM notes WHERE deleted_at IS ${trash ? 'NOT ' : ''}NULL`).get().n;
  }

  getNote(id, { withDeleted = false } = {}) {
    const r = this.q('SELECT * FROM notes WHERE id = ?').get(id);
    if (!r || (r.deleted_at && !withDeleted)) return null;
    return { ...noteMeta(r), lines: JSON.parse(r.lines) };
  }

  insertNote(n) {
    const t = now();
    this.q(`INSERT INTO notes (id, title, source_lang, target_lang, engine, lines, line_count, char_count,
        translated_count, preview, version, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      n.id, n.title, n.sourceLang, n.targetLang, n.engine, JSON.stringify(n.lines), n.stats.lineCount,
      n.stats.charCount, n.stats.translatedCount, n.stats.preview, n.pinned ? 1 : 0, n.createdAt || t, n.updatedAt || t,
    );
    return this.getNote(n.id);
  }

  updateNote(id, n) {
    const t = now();
    this.q(`UPDATE notes SET title = ?, source_lang = ?, target_lang = ?, engine = ?, lines = ?, line_count = ?,
        char_count = ?, translated_count = ?, preview = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(
      n.title, n.sourceLang, n.targetLang, n.engine, JSON.stringify(n.lines), n.stats.lineCount, n.stats.charCount,
      n.stats.translatedCount, n.stats.preview, t, id,
    );
    return this.q('SELECT version, updated_at FROM notes WHERE id = ?').get(id);
  }

  patchNote(id, fields) {
    const map = { title: 'title', sourceLang: 'source_lang', targetLang: 'target_lang', engine: 'engine', pinned: 'pinned' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'pinned' ? (fields[k] ? 1 : 0) : fields[k]);
    }
    if (!sets.length) return;
    this.q(`UPDATE notes SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
  }

  softDeleteNote(id) {
    return this.q('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id).changes > 0;
  }

  restoreNote(id) {
    return this.q('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id).changes > 0;
  }

  purgeNote(id) {
    return this.tx(() => {
      this.q('DELETE FROM note_revisions WHERE note_id = ?').run(id);
      return this.q('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
    });
  }

  purgeTrash(olderThanMs) {
    const ids = this.q('SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(now() - olderThanMs);
    for (const { id } of ids) this.purgeNote(id);
    return ids.length;
  }

  // ---------------------------------------------------------------- revisions
  lastRevision(noteId) {
    return this.q('SELECT id, created_at, line_count FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(noteId);
  }

  addRevision(noteId, { version, title, lines, reason }) {
    this.q('INSERT INTO note_revisions (note_id, version, title, lines, line_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(noteId, version, title, JSON.stringify(lines), lines.length, reason, now());
  }

  pruneRevisions(noteId, keep) {
    this.q(`DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN
      (SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`).run(noteId, noteId, keep);
  }

  listRevisions(noteId) {
    return this.q('SELECT id, version, title, line_count, reason, created_at FROM note_revisions WHERE note_id = ? ORDER BY created_at DESC, id DESC')
      .all(noteId).map((r) => ({ id: r.id, version: r.version, title: r.title, lineCount: r.line_count, reason: r.reason, createdAt: r.created_at }));
  }

  getRevision(noteId, revId) {
    const r = this.q('SELECT * FROM note_revisions WHERE note_id = ? AND id = ?').get(noteId, revId);
    if (!r) return null;
    return { id: r.id, version: r.version, title: r.title, lines: JSON.parse(r.lines), reason: r.reason, createdAt: r.created_at };
  }

  countRevisions() {
    return this.q('SELECT COUNT(*) n FROM note_revisions').get().n;
  }

  // ---------------------------------------------------------------- engines
  listEngineRows() {
    return this.q('SELECT * FROM engines ORDER BY priority ASC, created_at ASC').all().map(engineRow);
  }

  getEngineRow(id) {
    const r = this.q('SELECT * FROM engines WHERE id = ?').get(id);
    return r ? engineRow(r) : null;
  }

  upsertEngineRow(e) {
    const t = now();
    this.q(`INSERT INTO engines (id, type, name, enabled, in_auto, priority, config, builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, enabled = excluded.enabled,
        in_auto = excluded.in_auto, priority = excluded.priority, config = excluded.config, updated_at = excluded.updated_at`).run(
      e.id, e.type, e.name, e.enabled ? 1 : 0, e.inAuto ? 1 : 0, e.priority ?? 100, JSON.stringify(e.config || {}),
      e.builtin ? 1 : 0, t, t,
    );
  }

  deleteEngineRow(id) {
    return this.q('DELETE FROM engines WHERE id = ?').run(id).changes > 0;
  }

  // ---------------------------------------------------------------- translation cache
  cacheGetMany(keys) {
    const out = new Map();
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = keys.slice(i, i + 400);
      const rows = this.db.prepare(`SELECT key, out, detected, engine FROM tcache WHERE key IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
      for (const r of rows) out.set(r.key, r);
    }
    if (out.size) {
      const t = now();
      const upd = this.q('UPDATE tcache SET hits = hits + 1, last_hit = ? WHERE key = ?');
      this.tx(() => { for (const k of out.keys()) upd.run(t, k); });
    }
    return out;
  }

  cachePutMany(entries) {
    if (!entries.length) return;
    const t = now();
    const ins = this.q(`INSERT INTO tcache (key, engine, sl, tl, src, out, detected, chars, hits, created_at, last_hit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(key) DO UPDATE SET out = excluded.out, detected = excluded.detected, last_hit = excluded.last_hit`);
    this.tx(() => {
      for (const e of entries) ins.run(e.key, e.engine, e.sl, e.tl, e.src, e.out, e.detected || null, e.src.length, t, t);
    });
  }

  cacheStats() {
    const r = this.q('SELECT COUNT(*) n, COALESCE(SUM(chars), 0) chars, COALESCE(SUM(hits), 0) hits FROM tcache').get();
    const byEngine = this.q('SELECT engine, COUNT(*) n, COALESCE(SUM(hits), 0) hits FROM tcache GROUP BY engine ORDER BY n DESC').all();
    return { entries: r.n, chars: r.chars, hits: r.hits, byEngine: byEngine.map((x) => ({ ...x })) };
  }

  cacheSearch({ q = '', engine = '', limit = 100, offset = 0 } = {}) {
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    return this.q(`SELECT key, engine, sl, tl, src, out, detected, hits, created_at, last_hit FROM tcache
      WHERE (? = '' OR src LIKE ? ESCAPE '\\' OR out LIKE ? ESCAPE '\\') AND (? = '' OR engine = ?)
      ORDER BY last_hit DESC LIMIT ? OFFSET ?`).all(q, like, like, engine, engine, limit, offset).map((r) => ({ ...r }));
  }

  cacheDelete(key) {
    return this.q('DELETE FROM tcache WHERE key = ?').run(key).changes;
  }

  cacheClear(engine = '') {
    if (engine) return this.q('DELETE FROM tcache WHERE engine = ?').run(engine).changes;
    return this.q('DELETE FROM tcache').run().changes;
  }

  cachePrune(maxEntries) {
    const n = this.q('SELECT COUNT(*) n FROM tcache').get().n;
    if (n <= maxEntries) return 0;
    return this.q('DELETE FROM tcache WHERE key IN (SELECT key FROM tcache ORDER BY last_hit ASC LIMIT ?)').run(n - maxEntries).changes;
  }

  // ---------------------------------------------------------------- usage
  addUsage(engine, { requests = 0, chars = 0, errors = 0, cacheHits = 0, cachedChars = 0 }) {
    this.q(`INSERT INTO usage (day, engine, requests, chars, errors, cache_hits, cached_chars) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, engine) DO UPDATE SET requests = requests + excluded.requests, chars = chars + excluded.chars,
        errors = errors + excluded.errors, cache_hits = cache_hits + excluded.cache_hits, cached_chars = cached_chars + excluded.cached_chars`)
      .run(day(), engine, requests, chars, errors, cacheHits, cachedChars);
  }

  usageSince(days) {
    const from = day(Date.now() - (days - 1) * 86400000);
    return this.q('SELECT * FROM usage WHERE day >= ? ORDER BY day ASC').all(from).map((r) => ({ ...r }));
  }

  usageTotals(engine, fromDay) {
    return { ...this.q('SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(chars),0) chars, COALESCE(SUM(errors),0) errors FROM usage WHERE engine = ? AND day >= ?').get(engine, fromDay) };
  }

  // ---------------------------------------------------------------- logs
  log(level, source, message, data) {
    this.q('INSERT INTO logs (ts, level, source, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(now(), level, source, String(message).slice(0, 2000), data == null ? null : JSON.stringify(data).slice(0, 4000));
  }

  listLogs({ level = '', limit = 200, before = 0 } = {}) {
    return this.q(`SELECT * FROM logs WHERE (? = '' OR level = ?) AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(level, level, before, before, limit).map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  }

  pruneLogs(keep = 5000) {
    this.q('DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep);
  }

  clearLogs() {
    return this.q('DELETE FROM logs').run().changes;
  }

  // ---------------------------------------------------------------- misc
  stats() {
    const n = this.q(`SELECT COUNT(*) notes, COALESCE(SUM(line_count),0) lines, COALESCE(SUM(char_count),0) chars,
      COALESCE(SUM(translated_count),0) translated FROM notes WHERE deleted_at IS NULL`).get();
    return { ...n, trash: this.countNotes(true), revisions: this.countRevisions() };
  }

  sizeBytes() {
    let total = 0;
    for (const f of [this.file, this.file + '-wal', this.file + '-shm']) {
      try { total += fs.statSync(f).size; } catch { /* missing */ }
    }
    return total;
  }

  backupTo(target) {
    try { fs.unlinkSync(target); } catch { /* none */ }
    this.db.prepare('VACUUM INTO ?').run(target);
  }
}

function noteMeta(r) {
  return {
    id: r.id,
    title: r.title,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    engine: r.engine,
    lineCount: r.line_count,
    charCount: r.char_count,
    translatedCount: r.translated_count,
    preview: r.preview,
    version: r.version,
    pinned: !!r.pinned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
  };
}

function engineRow(r) {
  let config = {};
  try { config = JSON.parse(r.config); } catch { /* ignore */ }
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: !!r.enabled,
    inAuto: !!r.in_auto,
    priority: r.priority,
    config,
    builtin: !!r.builtin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export { day };
