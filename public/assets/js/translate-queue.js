// Incremental translation: only lines whose translation key changed are sent.
// Keys come from the shared markup plan (text + structure + languages), so
// editing one line translates one line; reopening a note translates nothing.
import { planSegments, assemble } from '../../shared/markup.js';
import { api } from './api.js';
import { browserTranslate } from './browser-google.js';

const MAX_SEGS = 80;
const MAX_CHARS = 6000;

export class TranslationQueue extends EventTarget {
  constructor(editor, { getState }) {
    super();
    this.editor = editor;
    this.getState = getState;
    this.timer = null;
    this.inflight = new Map(); // lineId -> key
    this.running = 0;
    this.generation = 0;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay ?? this.getState().delay ?? 450);
  }

  flushNow() {
    clearTimeout(this.timer);
    return this.flush();
  }

  /** Forget in-flight work (note switched). */
  reset() {
    clearTimeout(this.timer);
    this.inflight.clear();
    this.generation++;
  }

  pendingCount() {
    return this.inflight.size;
  }

  todoCount() {
    return this.collect(true).length;
  }

  collect(includeErrors = false) {
    const ed = this.editor;
    const out = [];
    for (let i = 0; i < ed.lines.length; i++) {
      const plan = ed.plans[i];
      if (!plan || plan.mode !== 'translate') continue;
      const line = ed.lines[i];
      if (line.trManual || line.id === ed.slashActive) continue;
      const key = ed.keyFor(i);
      if (line.trKey === key && line.tr) continue;
      if (this.inflight.get(line.id) === key) continue;
      if (!includeErrors && line._error && line._errorKey === key) continue;
      out.push({ id: line.id, key, plan, segs: planSegments(plan) });
    }
    return out;
  }

  async flush({ retryErrors = false } = {}) {
    const st = this.getState();
    if (st.paused || !st.target) return this.emitStatus();
    const jobs = this.collect(retryErrors);
    if (!jobs.length) return this.emitStatus();
    const gen = this.generation;
    const chunks = [];
    let cur = [];
    let segs = 0;
    let chars = 0;
    for (const j of jobs) {
      const c = j.segs.reduce((a, s) => a + s.length, 0);
      if (cur.length && (segs + j.segs.length > MAX_SEGS || chars + c > MAX_CHARS)) {
        chunks.push(cur);
        cur = [];
        segs = 0;
        chars = 0;
      }
      cur.push(j);
      segs += j.segs.length;
      chars += c;
    }
    if (cur.length) chunks.push(cur);
    for (const j of jobs) this.inflight.set(j.id, j.key);
    this.editor.setPending(jobs.map((j) => j.id), true);
    this.emitStatus();
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const ch = chunks[next++];
        this.running++;
        try {
          await this.run(ch, st, gen);
        } finally {
          this.running--;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, worker));
    this.emitStatus();
  }

  async viaBrowser(texts, st, { useCache = true } = {}) {
    let results = texts.map(() => ({ text: null, miss: true }));
    if (useCache) {
      try {
        const r = await api.post('api/translate', { texts, source: st.source, target: st.target, engine: st.browserEngineId, markup: true });
        results = r.results;
      } catch { /* cache lookup is optional */ }
    }
    const miss = texts.map((t, k) => (results[k]?.text == null ? k : -1)).filter((k) => k >= 0);
    if (miss.length) {
      const br = await browserTranslate(miss.map((k) => texts[k]), st.source, st.target);
      miss.forEach((k, m) => { results[k] = { ...br.results[m], cached: false }; });
      api.post('api/translate/browser', {
        source: st.source, target: st.target, markup: true, requests: br.requests,
        items: miss.map((k, m) => ({ text: texts[k], out: br.results[m].text, detected: br.results[m].detected })),
      }).catch(() => {});
    }
    return results;
  }

  async run(jobs, st, gen) {
    const texts = [...new Set(jobs.flatMap((j) => j.segs))];
    let results;
    let errors = [];
    try {
      if (st.engineIsBrowser) {
        results = await this.viaBrowser(texts, st);
      } else {
        const r = await api.post('api/translate', { texts, source: st.source, target: st.target, engine: st.engine, markup: true });
        results = r.results;
        errors = r.errors || [];
        const failed = texts.map((t, k) => (results[k]?.text == null ? k : -1)).filter((k) => k >= 0);
        if (failed.length && st.browserFallback && st.browserEngineId) {
          try {
            const fb = await this.viaBrowser(failed.map((k) => texts[k]), st, { useCache: false });
            failed.forEach((k, m) => { if (fb[m]?.text != null) results[k] = fb[m]; });
            this.emit('fallback', { count: failed.length });
          } catch (e) {
            errors.push({ engine: 'google-browser', message: e.message });
          }
        }
      }
    } catch (e) {
      if (gen !== this.generation) return;
      for (const j of jobs) {
        if (this.inflight.get(j.id) === j.key) this.inflight.delete(j.id);
        this.editor.setError(j.id, e.message);
        const i = this.editor.idx(j.id);
        if (i >= 0) this.editor.lines[i]._errorKey = j.key;
      }
      this.emit('error', { message: e.message, offline: e.status === 0 });
      return;
    }
    if (gen !== this.generation) return;
    const byText = new Map(texts.map((t, k) => [t, results[k]]));
    let detected = null;
    let done = 0;
    let failedLines = 0;
    for (const j of jobs) {
      if (this.inflight.get(j.id) !== j.key) continue; // superseded by a newer request
      this.inflight.delete(j.id);
      const i = this.editor.idx(j.id);
      if (i < 0) continue;
      if (this.editor.keyFor(i) !== j.key) {
        this.editor.setPending([j.id], false); // edited meanwhile; the next flush picks it up
        continue;
      }
      const outs = j.segs.map((s) => byText.get(s));
      const bad = outs.find((o) => !o || o.text == null);
      if (bad) {
        failedLines++;
        this.editor.setError(j.id, bad?.error || errors[errors.length - 1]?.message || 'Not translated');
        this.editor.lines[i]._errorKey = j.key;
        continue;
      }
      const tr = assemble(j.plan, outs.map((o) => o.text));
      const engine = outs.find((o) => o.engine)?.engine || '';
      if (this.editor.setTranslation(j.id, { tr, trKey: j.key, trEngine: engine })) done++;
      detected ||= outs.find((o) => o.detected)?.detected || null;
    }
    if (detected) this.emit('detected', { lang: detected });
    if (done) this.emit('translated', { count: done });
    if (failedLines) this.emit('error', { message: errors[errors.length - 1]?.message || 'Some lines could not be translated', errors });
  }

  emitStatus() {
    this.emit('status', { pending: this.inflight.size });
  }
}
