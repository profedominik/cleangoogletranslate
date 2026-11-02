// Autosave with optimistic versioning, offline local backup and conflict detection.
import { api } from './api.js';

const BACKUP = (id) => `ct:pending:${id}`;

export class NoteSync extends EventTarget {
  constructor({ getPayload, delay = 800 }) {
    super();
    this.getPayload = getPayload;
    this.delay = delay;
    this.noteId = null;
    this.version = null;
    this.dirty = false;
    this.saving = null;
    this.again = false;
    this.timer = null;
    this.backupTimer = null;
    this.retryMs = 0;
    this.state = 'saved';
    window.addEventListener('online', () => { if (this.dirty) this.save(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushOnHide(); });
    window.addEventListener('pagehide', () => this.flushOnHide());
    window.addEventListener('beforeunload', () => { if (this.dirty) this.writeBackup(); });
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(s, message = '') {
    this.state = s;
    this.emit('state', { state: s, message });
  }

  attach(note) {
    clearTimeout(this.timer);
    this.noteId = note.id;
    this.version = note.version;
    this.dirty = false;
    this.retryMs = 0;
    this.setState('saved');
  }

  markDirty(kind = 'orig') {
    if (!this.noteId) return;
    const now = Date.now();
    if (!this.dirty) this.dirtySince = now;
    this.dirty = true;
    if (this.state !== 'conflict') this.setState('dirty');
    // Typing debounces the save; translation updates never postpone an earlier save;
    // and nothing waits more than MAX_WAIT after the first unsaved change.
    const MAX_WAIT = 5000;
    const delay = kind === 'tr' ? Math.max(this.delay, 2500) : this.delay;
    const due = Math.min(now + delay, (this.dirtySince || now) + MAX_WAIT);
    if (!(this.timer && kind === 'tr' && this.dueAt <= due)) {
      clearTimeout(this.timer);
      this.dueAt = due;
      this.timer = setTimeout(() => { this.timer = null; this.save(); }, Math.max(0, due - now));
    }
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => this.writeBackup(), 1500);
  }

  async save({ force = false, keepalive = false } = {}) {
    if (!this.noteId) return;
    if (this.state === 'conflict' && !force) return;
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty && !force) return;
    const id = this.noteId;
    const payload = { ...this.getPayload(), baseVersion: this.version };
    if (force) payload.force = true;
    this.dirty = false;
    this.again = false;
    this.setState('saving');
    this.saving = (async () => {
      try {
        const r = await api.put(`api/notes/${id}`, payload, { keepalive: keepalive && JSON.stringify(payload).length < 60000 });
        if (id !== this.noteId) return;
        this.version = r.version;
        this.retryMs = 0;
        if (!this.dirty) this.clearBackup(id);
        this.setState(this.dirty ? 'dirty' : 'saved');
        this.emit('saved', r);
      } catch (e) {
        if (id !== this.noteId) return;
        this.dirty = true;
        if (e.status === 409) {
          this.writeBackup();
          this.setState('conflict', e.message);
          this.emit('conflict', e.data || {});
        } else if (e.status === 404) {
          this.setState('error', 'This note no longer exists on the server');
          this.emit('missing');
        } else {
          this.writeBackup();
          this.setState(e.status === 0 ? 'offline' : 'error', e.message);
          this.retryLater();
        }
      } finally {
        this.saving = null;
        if (id === this.noteId && (this.again || this.dirty) && ['dirty', 'saved'].includes(this.state)) {
          clearTimeout(this.timer);
          this.dueAt = Date.now() + 300;
          this.timer = setTimeout(() => { this.timer = null; this.save(); }, 300);
        }
      }
    })();
    return this.saving;
  }

  retryLater() {
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 2000, 60000);
    clearTimeout(this.timer);
    this.dueAt = Date.now() + this.retryMs;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, this.retryMs);
  }

  /** Make sure everything is on the server (before switching notes / exporting). */
  async flush() {
    if (this.saving) await this.saving;
    if (this.dirty && this.state !== 'conflict') await this.save();
  }

  flushOnHide() {
    if (!this.dirty || !this.noteId) return;
    this.writeBackup();
    if (this.state !== 'conflict') this.save({ keepalive: true });
  }

  writeBackup() {
    if (!this.noteId) return;
    try {
      localStorage.setItem(BACKUP(this.noteId), JSON.stringify({ baseVersion: this.version, savedAt: Date.now(), payload: this.getPayload() }));
    } catch { /* quota / private mode */ }
  }

  clearBackup(id = this.noteId) {
    try { localStorage.removeItem(BACKUP(id)); } catch { /* ignore */ }
  }

  static pendingFor(id) {
    try {
      const raw = localStorage.getItem(BACKUP(id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
