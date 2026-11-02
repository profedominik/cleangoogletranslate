// Notes service: validation, stats, optimistic concurrency, revisions.
import { analyze, buildTagMap, newId } from '../public/shared/markup.js';
import { normalizeLang } from '../public/shared/languages.js';
import { HttpError } from './http.js';

const MAX_LINES = 50000;
const MAX_LINE = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Normalise incoming lines (strings or objects). Lines containing newlines are split. */
export function sanitizeLines(input) {
  if (input == null) return [];
  if (typeof input === 'string') input = input.split(/\r?\n/);
  if (!Array.isArray(input)) throw new HttpError(400, '"lines" must be an array');
  const seen = new Set();
  const out = [];
  for (const l of input) {
    const obj = typeof l === 'string' ? { text: l } : l && typeof l === 'object' ? l : { text: String(l ?? '') };
    const texts = String(obj.text ?? '').split(/\r?\n/);
    texts.forEach((text, k) => {
      let id = k === 0 && typeof obj.id === 'string' && ID_RE.test(obj.id) && !seen.has(obj.id) ? obj.id : newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
      const line = { id, text: text.slice(0, MAX_LINE) };
      if (k === 0) {
        if (typeof obj.tr === 'string' && obj.tr) line.tr = obj.tr.replace(/\r?\n/g, ' ').slice(0, MAX_LINE * 2);
        if (typeof obj.trKey === 'string' && obj.trKey) line.trKey = obj.trKey.slice(0, 64);
        if (obj.trManual === true) line.trManual = true;
        if (typeof obj.trEngine === 'string' && obj.trEngine) line.trEngine = obj.trEngine.slice(0, 64);
      }
      out.push(line);
    });
    if (out.length > MAX_LINES) throw new HttpError(413, `A note can have at most ${MAX_LINES} lines`);
  }
  return out;
}

export function noteStats(lines, tagMap) {
  const info = analyze(lines.map((l) => l.text), tagMap);
  let charCount = 0;
  let translatedCount = 0;
  const previewParts = [];
  let firstText = '';
  lines.forEach((l, i) => {
    charCount += l.text.length;
    if (l.tr) translatedCount++;
    const inf = info[i];
    if ((inf.role === 'text' || inf.role === 'inline') && inf.body.trim()) {
      const clean = inf.body.slice(inf.md.prefix.length).trim();
      if (!firstText) firstText = clean;
      if (previewParts.join(' · ').length < 160) previewParts.push(clean);
    }
  });
  return {
    lineCount: lines.length,
    charCount,
    translatedCount,
    preview: previewParts.join(' · ').slice(0, 200),
    firstText: firstText.slice(0, 80),
  };
}

export function createNotesService({ store, settings }) {
  const tagMap = () => buildTagMap(settings().tags);

  function build(fields, base = {}) {
    const lines = fields.lines !== undefined ? sanitizeLines(fields.lines) : base.lines || [];
    const stats = noteStats(lines, tagMap());
    const src = fields.sourceLang !== undefined ? normalizeLang(fields.sourceLang) : base.sourceLang;
    const tgt = fields.targetLang !== undefined ? normalizeLang(fields.targetLang, { allowAuto: false }) : base.targetLang;
    if (!src) throw new HttpError(400, 'Unknown source language');
    if (!tgt) throw new HttpError(400, 'Unknown target language');
    const title = fields.title !== undefined ? String(fields.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : base.title ?? '';
    return {
      title,
      sourceLang: src,
      targetLang: tgt,
      engine: fields.engine !== undefined ? String(fields.engine || 'auto').slice(0, 64) : base.engine || 'auto',
      lines,
      stats,
      pinned: fields.pinned !== undefined ? !!fields.pinned : !!base.pinned,
    };
  }

  function maybeRevision(id, version, n, prevLines) {
    const s = settings();
    const last = store.lastRevision(id);
    const due = !last || Date.now() - last.created_at > s.revisionIntervalMin * 60_000;
    // Large deletions are snapshotted *before* they are applied, so they can be undone.
    if (prevLines && prevLines.length >= 10 && n.lines.length < prevLines.length * 0.5) {
      store.addRevision(id, { version: version - 1, title: n.title, lines: prevLines, reason: 'before-large-delete' });
    }
    if (due) store.addRevision(id, { version, title: n.title, lines: n.lines, reason: 'auto' });
    store.pruneRevisions(id, s.revisionKeep);
  }

  return {
    list(opts) {
      return store.listNotes(opts);
    },

    get(id) {
      const n = store.getNote(id);
      if (!n) throw new HttpError(404, 'Note not found');
      return n;
    },

    create(fields = {}) {
      const s = settings();
      const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
      const n = build({
        sourceLang: s.defaultSource,
        targetLang: s.defaultTarget,
        engine: s.defaultEngine,
        lines: [{ text: '' }],
        ...given,
      });
      if (!n.lines.length) n.lines = sanitizeLines(['']);
      const id = typeof fields.id === 'string' && ID_RE.test(fields.id) && !store.getNote(fields.id, { withDeleted: true }) ? fields.id : newId();
      const note = store.insertNote({ id, ...n });
      store.addRevision(id, { version: 1, title: n.title, lines: n.lines, reason: 'created' });
      return note;
    },

    /** Full save from the editor. Throws 409 when baseVersion is stale (unless force). */
    save(id, payload, { force = false } = {}) {
      const cur = store.getNote(id);
      if (!cur) throw new HttpError(404, 'Note not found');
      if (!force && payload.baseVersion != null && Number(payload.baseVersion) !== cur.version) {
        throw new HttpError(409, 'This note was changed somewhere else', { current: { version: cur.version, updatedAt: cur.updatedAt, title: cur.title } });
      }
      const n = build(payload, cur);
      const r = store.tx(() => {
        const res = store.updateNote(id, n);
        maybeRevision(id, res.version, n, cur.lines);
        return res;
      });
      return { id, version: r.version, updatedAt: r.updated_at, title: n.title, lineCount: n.stats.lineCount };
    },

    patch(id, fields) {
      const cur = store.getNote(id);
      if (!cur) throw new HttpError(404, 'Note not found');
      const n = build({ ...fields, lines: undefined }, cur);
      store.patchNote(id, {
        title: fields.title !== undefined ? n.title : undefined,
        sourceLang: fields.sourceLang !== undefined ? n.sourceLang : undefined,
        targetLang: fields.targetLang !== undefined ? n.targetLang : undefined,
        engine: fields.engine !== undefined ? n.engine : undefined,
        pinned: fields.pinned !== undefined ? n.pinned : undefined,
      });
      return store.getNote(id);
    },

    remove(id) {
      if (!store.softDeleteNote(id)) throw new HttpError(404, 'Note not found');
      store.log('info', 'notes', 'Note moved to trash', { id });
    },

    restore(id) {
      if (!store.restoreNote(id)) throw new HttpError(404, 'Note not found');
      store.log('info', 'notes', 'Note restored from trash', { id });
    },

    purge(id) {
      if (!store.purgeNote(id)) throw new HttpError(404, 'Note not found');
      store.log('info', 'notes', 'Note permanently deleted', { id });
    },

    duplicate(id) {
      const cur = this.get(id);
      return this.create({
        title: `${cur.title || 'Untitled'} (copy)`,
        sourceLang: cur.sourceLang,
        targetLang: cur.targetLang,
        engine: cur.engine,
        lines: cur.lines.map(({ id: _drop, ...rest }) => rest),
      });
    },

    revisions(id) {
      this.get(id);
      return store.listRevisions(id);
    },

    revision(id, revId) {
      const r = store.getRevision(id, Number(revId));
      if (!r) throw new HttpError(404, 'Revision not found');
      return r;
    },

    restoreRevision(id, revId) {
      const cur = this.get(id);
      const rev = this.revision(id, revId);
      store.addRevision(id, { version: cur.version, title: cur.title, lines: cur.lines, reason: 'before-restore' });
      const n = build({ lines: rev.lines, title: rev.title }, cur);
      const r = store.updateNote(id, n);
      store.addRevision(id, { version: r.version, title: n.title, lines: n.lines, reason: `restored #${rev.id}` });
      store.pruneRevisions(id, settings().revisionKeep);
      store.log('info', 'notes', 'Revision restored', { id, revision: rev.id });
      return store.getNote(id);
    },

    displayTitle(note) {
      return note.title || noteStats(note.lines, tagMap()).firstText || 'Untitled';
    },
  };
}
