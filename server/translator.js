// Translation service: engine registry + cache + dedupe + markup protection +
// auto fallback chain + cool-downs + throttling + usage accounting.
import { ENGINE_TYPES, DEFAULT_ENGINES, isConfigured, EngineError } from './engines/index.js';
import { splitText } from './engines/base.js';
import { protect, restore, splitProtected } from '../public/shared/markup.js';
import { normalizeLang } from '../public/shared/languages.js';
import { cacheKey } from './db.js';
import { HttpError } from './http.js';

const HAS_LETTER = /\p{L}/u;
const NO_SPACE_LANGS = new Set(['ja', 'zh-CN', 'zh-TW', 'th', 'lo', 'km', 'my']);

/** Per-engine concurrency + minimum spacing between request starts. */
export class Limiter {
  constructor(concurrency = 2, minInterval = 0) {
    this.concurrency = Math.max(1, concurrency);
    this.minInterval = minInterval;
    this.active = 0;
    this.queue = [];
    this.last = 0;
    this.timer = null;
  }

  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const wait = this.last + this.minInterval - Date.now();
      if (wait > 0) {
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        return;
      }
      const job = this.queue.shift();
      this.active++;
      this.last = Date.now();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

function msUntilUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime() + 60_000;
}

function normDetected(d) {
  if (!d || typeof d !== 'string') return null;
  const n = normalizeLang(d);
  return n && n !== 'auto' ? n : null;
}

export class Translator {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {() => object} o.settings  returns current settings
   */
  constructor({ store, settings, testMode = false }) {
    this.store = store;
    this.settings = settings;
    this.testMode = testMode;
    this.state = new Map();
    this.limiters = new Map();
    this.instances = new Map();
    this.ensureEngines();
  }

  ensureEngines() {
    const existing = new Set(this.store.listEngineRows().map((r) => r.id));
    for (const e of DEFAULT_ENGINES) {
      if (!existing.has(e.id)) this.store.upsertEngineRow({ ...e, builtin: true, config: e.config || {} });
    }
    if (this.testMode && !existing.has('echo')) {
      this.store.upsertEngineRow({ id: 'echo', type: 'echo', name: 'Echo (test)', enabled: true, inAuto: true, priority: 1, builtin: false, config: { mode: 'upper' } });
    }
  }

  rows() {
    return this.store.listEngineRows().filter((r) => ENGINE_TYPES[r.type]);
  }

  st(id) {
    let s = this.state.get(id);
    if (!s) {
      s = { cooldownUntil: 0, strikes: 0, netFails: 0, lastError: null, lastErrorKind: null, lastErrorAt: 0, lastOkAt: 0, lastLatency: 0 };
      this.state.set(id, s);
    }
    return s;
  }

  status(row) {
    const s = this.st(row.id);
    const cooling = s.cooldownUntil > Date.now();
    return {
      configured: isConfigured(row),
      coolingDown: cooling,
      cooldownUntil: cooling ? s.cooldownUntil : 0,
      lastError: s.lastError,
      lastErrorKind: s.lastErrorKind,
      lastErrorAt: s.lastErrorAt,
      lastOkAt: s.lastOkAt,
      lastLatency: s.lastLatency,
    };
  }

  resetCooldown(id) {
    const s = this.st(id);
    s.cooldownUntil = 0;
    s.strikes = 0;
    s.netFails = 0;
  }

  available(row) {
    return row.enabled && isConfigured(row) && ENGINE_TYPES[row.type].serverSide;
  }

  autoChain() {
    const rows = this.rows().filter((r) => r.inAuto && this.available(r));
    return this.testMode ? rows.filter((r) => r.type === 'echo') : rows;
  }

  /** Engines offered in the editor's engine picker. */
  publicEngines() {
    const now = Date.now();
    return this.rows()
      .filter((r) => r.enabled && isConfigured(r))
      .filter((r) => !this.testMode || r.type === 'echo' || r.type === 'google-browser')
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        serverSide: ENGINE_TYPES[r.type].serverSide,
        inAuto: r.inAuto,
        coolingDown: this.st(r.id).cooldownUntil > now,
      }));
  }

  adapter(row) {
    const sig = `${row.updatedAt}:${JSON.stringify(row.config)}`;
    const hit = this.instances.get(row.id);
    if (hit && hit.sig === sig) return hit.adapter;
    const adapter = ENGINE_TYPES[row.type].create(row.config || {});
    this.instances.set(row.id, { sig, adapter });
    return adapter;
  }

  limiter(row) {
    let l = this.limiters.get(row.id);
    if (!l) {
      const def = ENGINE_TYPES[row.type];
      l = new Limiter(def.concurrency || 2, def.minInterval || 0);
      this.limiters.set(row.id, l);
    }
    return l;
  }

  onSuccess(row, ms) {
    const s = this.st(row.id);
    s.strikes = 0;
    s.netFails = 0;
    s.lastOkAt = Date.now();
    s.lastLatency = ms;
  }

  onError(row, err) {
    const s = this.st(row.id);
    s.lastError = err.message;
    s.lastErrorKind = err.kind;
    s.lastErrorAt = Date.now();
    const base = (Number(this.settings().cooldownSec) || 60) * 1000;
    let cool = 0;
    if (err.kind === 'rate_limit') {
      s.strikes++;
      cool = err.retryAfter ? err.retryAfter * 1000 : Math.min(base * 2 ** (s.strikes - 1), 60 * 60_000);
    } else if (err.kind === 'quota') {
      cool = msUntilUtcMidnight();
    } else if (err.kind === 'auth') {
      cool = 5 * 60_000;
    } else if (['network', 'timeout', 'server'].includes(err.kind)) {
      s.netFails++;
      if (s.netFails >= 3) cool = Math.min(30_000 * 2 ** (s.netFails - 3), 15 * 60_000);
    }
    if (cool) s.cooldownUntil = Date.now() + cool;
    this.store.addUsage(row.id, { errors: 1 });
    const level = cool ? 'warn' : 'error';
    this.store.log(level, `engine:${row.id}`, err.message, { kind: err.kind, cooldownSec: Math.round(cool / 1000) || undefined });
  }

  /**
   * Translate many texts. Each result: { text, detected, engine, cached } or { text: null, error } /
   * { text: null, miss: true } when only the cache was consulted (browser engine).
   */
  async translate({ texts, source = 'auto', target, engine = 'auto', markup = false, useCache = true }) {
    if (!Array.isArray(texts)) throw new HttpError(400, '"texts" must be an array of strings');
    const sl = normalizeLang(source);
    if (!sl) throw new HttpError(400, `Unsupported source language "${source}"`);
    const tl = normalizeLang(target, { allowAuto: false });
    if (!tl) throw new HttpError(400, `Unsupported or missing target language "${target ?? ''}"`);
    const settings = this.settings();
    const cacheOn = useCache && settings.cacheEnabled !== false;

    const results = new Array(texts.length);
    const uniq = new Map();
    texts.forEach((raw, i) => {
      const s = String(raw ?? '');
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      const core = m[2];
      const probe = markup ? protect(core).text.replace(/\{\d+\}/g, '') : core;
      if (!core || !HAS_LETTER.test(probe) || sl === tl) {
        results[i] = { text: s, detected: sl === tl ? sl : null, engine: null, cached: false, skipped: true };
        return;
      }
      let u = uniq.get(core);
      if (!u) {
        u = { core, at: [] };
        uniq.set(core, u);
      }
      u.at.push({ i, lead: m[1], trail: m[3] });
    });
    const items = [...uniq.values()];

    let chain;
    if (!engine || engine === 'auto') {
      chain = this.autoChain();
    } else {
      const row = this.store.getEngineRow(engine);
      if (!row || !ENGINE_TYPES[row.type]) throw new HttpError(404, `Unknown engine "${engine}"`);
      if (!row.enabled) throw new HttpError(400, `Engine "${row.name}" is disabled`);
      chain = [row];
    }

    if (cacheOn && items.length && chain.length) {
      const keys = [];
      for (const it of items) for (const e of chain) keys.push(cacheKey(e.id, sl, tl, markup, it.core));
      const hits = this.store.cacheGetMany(keys);
      const hitStats = new Map();
      for (const it of items) {
        for (const e of chain) {
          const h = hits.get(cacheKey(e.id, sl, tl, markup, it.core));
          if (!h) continue;
          it.done = { text: h.out, detected: h.detected, engine: e.id, cached: true };
          const hs = hitStats.get(e.id) || { n: 0, chars: 0 };
          hs.n++;
          hs.chars += it.core.length;
          hitStats.set(e.id, hs);
          break;
        }
      }
      for (const [id, hs] of hitStats) this.store.addUsage(id, { cacheHits: hs.n, cachedChars: hs.chars });
    }

    let pending = items.filter((it) => !it.done);
    const errors = [];
    const browserOnly = chain.length > 0 && chain.every((r) => !ENGINE_TYPES[r.type].serverSide);
    if (pending.length && !browserOnly) {
      if (!chain.length) errors.push({ engine: null, kind: 'config', message: 'No translation engine is enabled and configured (see /admin → Engines)' });
      for (const row of chain) {
        if (!pending.length) break;
        if (!ENGINE_TYPES[row.type].serverSide) continue;
        if (!isConfigured(row)) {
          errors.push({ engine: row.id, kind: 'config', message: `${row.name} is not configured` });
          continue;
        }
        const st = this.st(row.id);
        if (st.cooldownUntil > Date.now()) {
          errors.push({ engine: row.id, kind: 'cooldown', message: `${row.name} is cooling down (${st.lastError || 'rate limited'})`, retryAt: st.cooldownUntil });
          continue;
        }
        try {
          const outs = await this.runEngine(row, pending.map((it) => it.core), sl, tl, markup);
          const toCache = [];
          pending.forEach((it, j) => {
            it.done = { text: outs[j].text, detected: outs[j].detected, engine: row.id, cached: false };
            if (cacheOn) toCache.push({ key: cacheKey(row.id, sl, tl, markup, it.core), engine: row.id, sl, tl, src: it.core, out: outs[j].text, detected: outs[j].detected });
          });
          if (toCache.length) this.store.cachePutMany(toCache);
          pending = [];
        } catch (err) {
          const e = err instanceof EngineError ? err : new EngineError('server', err?.message || String(err));
          this.onError(row, e);
          errors.push({ engine: row.id, kind: e.kind, message: e.message });
        }
      }
    }

    const counts = new Map();
    const lastError = errors.length ? errors[errors.length - 1].message : 'Not translated';
    for (const it of items) {
      for (const { i, lead, trail } of it.at) {
        if (it.done) {
          results[i] = { text: lead + it.done.text + trail, detected: it.done.detected || null, engine: it.done.engine, cached: it.done.cached };
        } else if (browserOnly) {
          results[i] = { text: null, miss: true };
        } else {
          results[i] = { text: null, error: lastError };
        }
      }
      if (it.done?.detected) counts.set(it.done.detected, (counts.get(it.done.detected) || 0) + it.at.length);
    }
    const detected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { results, errors, detected, source: sl, target: tl };
  }

  async runEngine(row, cores, sl, tl, markup) {
    const prepared = cores.map((c) => (markup ? protect(c) : { text: c, slots: [] }));
    const outs = await this.callChunked(row, prepared.map((p) => p.text), sl, tl);
    const final = new Array(cores.length);
    const redo = [];
    prepared.forEach((p, k) => {
      const r = restore(outs[k].text, p.slots);
      if (r == null) redo.push(k);
      else final[k] = { text: r, detected: outs[k].detected };
    });
    if (redo.length) {
      // The engine mangled the placeholders: translate the unprotected pieces on their own.
      const pieceTexts = [];
      const jobs = redo.map((k) => ({
        k,
        pieces: splitProtected(cores[k]).map((pc) => {
          if (pc.protected) return { keep: pc.text };
          const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(pc.text);
          if (!m[2] || !HAS_LETTER.test(m[2])) return { keep: pc.text };
          pieceTexts.push(m[2]);
          return { lead: m[1], idx: pieceTexts.length - 1, trail: m[3] };
        }),
      }));
      const pieceOuts = pieceTexts.length ? await this.callChunked(row, pieceTexts, sl, tl) : [];
      for (const { k, pieces } of jobs) {
        final[k] = {
          text: pieces.map((p) => (p.keep != null ? p.keep : p.lead + pieceOuts[p.idx].text + p.trail)).join(''),
          detected: outs[k].detected,
        };
      }
    }
    return final;
  }

  async callChunked(row, texts, sl, tl) {
    const def = ENGINE_TYPES[row.type];
    const adapter = this.adapter(row);
    const lim = this.limiter(row);
    const over = Number(row.config?.maxChars) > 0 ? { maxChars: Number(row.config.maxChars), maxItemChars: Number(row.config.maxChars) } : {};
    const { maxItems = 50, maxChars = 5000, maxItemChars = maxChars } = { ...def.batch, ...over };
    const subs = [];
    texts.forEach((t, owner) => {
      for (const piece of splitText(t, maxItemChars)) subs.push({ text: piece, owner });
    });
    const batches = [];
    let cur = [];
    let chars = 0;
    subs.forEach((s, i) => {
      if (cur.length && (cur.length >= maxItems || chars + s.text.length > maxChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(i);
      chars += s.text.length;
    });
    if (cur.length) batches.push(cur);

    const ctrl = new AbortController();
    const subOut = new Array(subs.length);
    let requests = 0;
    let sentChars = 0;
    const t0 = Date.now();
    try {
      await Promise.all(batches.map((b) => lim.schedule(async () => {
        if (ctrl.signal.aborted) throw new EngineError('timeout', 'Cancelled');
        const batchTexts = b.map((i) => subs[i].text);
        let r;
        try {
          r = await adapter.translate({ texts: batchTexts, source: sl, target: tl, signal: ctrl.signal });
        } catch (e) {
          ctrl.abort();
          throw e;
        }
        if (!r || !Array.isArray(r.translations) || r.translations.length !== b.length) {
          ctrl.abort();
          throw new EngineError('bad_response', `${row.name} returned the wrong number of translations`);
        }
        b.forEach((i, j) => {
          subOut[i] = {
            text: String(r.translations[j] ?? '').trim(),
            detected: normDetected(Array.isArray(r.detected) ? r.detected[j] : r.detected),
          };
        });
        requests += r.requests || 1;
        sentChars += batchTexts.reduce((a, t) => a + t.length, 0);
      })));
    } finally {
      if (requests) this.store.addUsage(row.id, { requests, chars: sentChars });
    }
    this.onSuccess(row, Date.now() - t0);

    const joiner = NO_SPACE_LANGS.has(tl) ? '' : ' ';
    const out = texts.map(() => ({ parts: [], detected: null }));
    subs.forEach((s, i) => {
      out[s.owner].parts.push(subOut[i].text);
      out[s.owner].detected ||= subOut[i].detected;
    });
    return out.map((o) => ({ text: o.parts.join(joiner), detected: o.detected }));
  }

  /** Store translations produced by the in-browser engine. */
  storeBrowserResults({ source, target, markup, items, requests = 0 }) {
    const sl = normalizeLang(source);
    const tl = normalizeLang(target, { allowAuto: false });
    if (!sl || !tl || !Array.isArray(items)) throw new HttpError(400, 'Invalid browser translation payload');
    const entries = [];
    let chars = 0;
    for (const it of items.slice(0, 2000)) {
      if (typeof it?.text !== 'string' || typeof it?.out !== 'string' || !it.text.trim()) continue;
      const src = it.text.trim().slice(0, 20000);
      chars += src.length;
      entries.push({ key: cacheKey('google-browser', sl, tl, !!markup, src), engine: 'google-browser', sl, tl, src, out: it.out.trim().slice(0, 40000), detected: normDetected(it.detected) });
    }
    if (this.settings().cacheEnabled !== false) this.store.cachePutMany(entries);
    this.store.addUsage('google-browser', { requests: Math.max(0, Math.min(Number(requests) || 0, 1000)), chars });
    return entries.length;
  }

  /** Admin "Test" button: bypasses cache and cool-down. */
  async test(id, { text = 'Hello, world! How are you today?', source = 'en', target = 'es' } = {}) {
    const row = this.store.getEngineRow(id);
    if (!row || !ENGINE_TYPES[row.type]) throw new HttpError(404, 'Unknown engine');
    if (!ENGINE_TYPES[row.type].serverSide) return { ok: false, error: 'This engine runs in the browser; test it from the editor.' };
    if (!isConfigured(row)) return { ok: false, error: 'Fill in the required settings first.' };
    const t0 = Date.now();
    try {
      const [r] = await this.runEngine(row, [text], normalizeLang(source) || 'en', normalizeLang(target, { allowAuto: false }) || 'es', true);
      this.store.log('info', `engine:${row.id}`, 'Test OK', { ms: Date.now() - t0 });
      return { ok: true, text: r.text, detected: r.detected, ms: Date.now() - t0 };
    } catch (err) {
      const e = err instanceof EngineError ? err : new EngineError('server', err?.message || String(err));
      this.onError(row, e);
      return { ok: false, error: e.message, kind: e.kind, ms: Date.now() - t0 };
    }
  }
}
