// The aligned two-pane editor.
//
// Every line is ONE grid row: [number][original][number][translation]. A row is
// as tall as its tallest cell, so both panes stay aligned line-for-line however
// long either side wraps, and both scroll together. Each cell is a transparent
// auto-growing <textarea> stacked on a highlight layer with identical metrics.
import {
  analyze, planLine, planKey, highlight, parseLine, serializeLine, buildTagMap, newId, remapLines, mdInfo,
} from '../../shared/markup.js';
import { esc } from './ui.js';
import { icon } from './icons.js';

const UNDO_LIMIT = 200;
const ROLE_MARKER = new Set(['open', 'close', 'marker']);

function caretRect(hl, pos) {
  const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  let n;
  let acc = 0;
  let last = null;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    last = n;
    if (pos <= acc + len) {
      const r = document.createRange();
      r.setStart(n, pos - acc);
      r.collapse(true);
      const rects = r.getClientRects();
      return rects[rects.length - 1] || r.getBoundingClientRect();
    }
    acc += len;
  }
  if (last) {
    const r = document.createRange();
    r.setStart(last, last.nodeValue.length);
    r.collapse(true);
    return r.getBoundingClientRect();
  }
  return null;
}

export class Editor extends EventTarget {
  constructor({ rowsEl, scroller, tags }) {
    super();
    this.el = rowsEl;
    this.scroller = scroller;
    this.tagMap = buildTagMap(tags);
    this.lines = [];
    this.info = [];
    this.plans = [];
    this.rowById = new Map();
    this.indexById = new Map();
    this.source = 'auto';
    this.target = 'en';
    this.undoStack = [];
    this.redoStack = [];
    this.lastInput = { at: 0, id: null, del: false };
    this.trMemory = new Map();
    this.selection = new Set();
    this.selAnchor = -1;
    this.curId = null;
    this.composing = false;
    this.plain = false;
    this.slashActive = null;
    this.readOnly = false;
    this.proto = this.buildProto();
    this.bind();
  }

  // ------------------------------------------------------------------ setup
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setTags(tags) {
    this.tagMap = buildTagMap(tags);
    this.refresh();
  }

  setLangs(source, target) {
    this.source = source;
    this.target = target;
    for (let i = 0; i < this.lines.length; i++) this.paintTr(i);
  }

  setPlain(plain) {
    this.plain = plain;
    for (let i = 0; i < this.lines.length; i++) this.paintRow(i, true);
  }

  buildProto() {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="ln" data-g="src"></div>'
      + '<div class="cell src"><span class="pills"></span><div class="ed"><div class="hl" dir="auto"></div>'
      + '<textarea class="ta" rows="1" dir="auto" spellcheck="true" autocomplete="off" aria-label="Original line"></textarea></div></div>'
      + '<div class="ln ln2" data-g="tr"></div>'
      + '<div class="cell tr"><span class="pills"></span><div class="ed"><div class="hl" dir="auto"></div>'
      + '<textarea class="ta" rows="1" dir="auto" spellcheck="false" tabindex="-1" autocomplete="off" aria-label="Translation"></textarea></div>'
      + '<button type="button" class="tr-st" tabindex="-1"></button></div>';
    return row;
  }

  createRow(line) {
    const row = this.proto.cloneNode(true);
    row.dataset.id = line.id;
    const [, src, , tr] = row.children;
    row._src = { cell: src, pills: src.firstChild, hl: src.querySelector('.hl'), ta: src.querySelector('.ta') };
    row._tr = { cell: tr, pills: tr.firstChild, hl: tr.querySelector('.hl'), ta: tr.querySelector('.ta'), st: tr.querySelector('.tr-st') };
    row._sig = '';
    row._trSig = '';
    return row;
  }

  // ------------------------------------------------------------------ model
  load(lines) {
    this.lines = (lines?.length ? lines : [{ text: '' }]).map((l) => ({
      id: l.id || newId(),
      text: l.text ?? '',
      tr: l.tr || '',
      trKey: l.trKey || '',
      trManual: !!l.trManual,
      trEngine: l.trEngine || '',
    }));
    this.trMemory.clear();
    for (const l of this.lines) if (l.tr) this.rememberTr(l);
    this.undoStack = [];
    this.redoStack = [];
    this.selection.clear();
    this.rowById.forEach((r) => r.remove());
    this.rowById.clear();
    this.el.replaceChildren();
    this.structural();
  }

  serialize() {
    return this.lines.map((l) => {
      const o = { id: l.id, text: l.text };
      if (l.tr) o.tr = l.tr;
      if (l.trKey) o.trKey = l.trKey;
      if (l.trManual) o.trManual = true;
      if (l.trEngine) o.trEngine = l.trEngine;
      return o;
    });
  }

  texts() {
    return this.lines.map((l) => l.text);
  }

  idx(id) {
    const i = this.indexById.get(id);
    return i == null ? -1 : i;
  }

  reindex() {
    this.indexById.clear();
    this.lines.forEach((l, i) => this.indexById.set(l.id, i));
  }

  recompute() {
    this.info = analyze(this.texts(), this.tagMap);
    this.plans = this.info.map(planLine);
  }

  keyFor(i) {
    return planKey(this.plans[i], this.source, this.target);
  }

  rememberTr(l) {
    this.trMemory.set(l.id, { tr: l.tr, trKey: l.trKey, trEngine: l.trEngine, trManual: l.trManual });
  }

  /** After lines were inserted/removed/reordered: reconcile DOM rows, repaint what changed. */
  structural() {
    this.reindex();
    this.recompute();
    const keep = new Set(this.lines.map((l) => l.id));
    for (const [id, row] of this.rowById) {
      if (!keep.has(id)) {
        row.remove();
        this.rowById.delete(id);
        this.selection.delete(id);
      }
    }
    let prev = null;
    for (const line of this.lines) {
      let row = this.rowById.get(line.id);
      if (!row) {
        row = this.createRow(line);
        this.rowById.set(line.id, row);
      }
      const expected = prev ? prev.nextSibling : this.el.firstChild;
      if (row !== expected) this.el.insertBefore(row, expected);
      prev = row;
    }
    this.paintAll();
    this.updateGutter();
    this.updatePlaceholder();
  }

  /** Re-run analysis after text edits (no rows added/removed). */
  refresh(changedIdx = null) {
    // Fast path for typing: if one line changed but its tags and emptiness did not,
    // no other line's structure can change, so only that line is re-analysed.
    if (changedIdx && changedIdx.length === 1) {
      const i = changedIdx[0];
      const old = this.info[i];
      const p = parseLine(this.lines[i].text, this.tagMap);
      const sameTokens = old && p.tokens.length === old.tokens.length
        && p.tokens.every((t, k) => t.name === old.tokens[k].name && t.closing === old.tokens[k].closing);
      if (sameTokens && !p.body.trim() === !old.body.trim()) {
        this.info[i] = { ...old, body: p.body, prefixLen: p.prefixLen, md: mdInfo(p.body) };
        this.plans[i] = planLine(this.info[i]);
        this.paintRow(i);
        this.updatePlaceholder();
        return;
      }
    }
    const prevSig = this.info.map((x) => `${x.section}|${x.spans}|${x.role}|${x.style}|${x.translate}`);
    this.recompute();
    let structureChanged = prevSig.length !== this.info.length;
    if (!structureChanged) {
      for (let i = 0; i < this.info.length; i++) {
        const x = this.info[i];
        if (prevSig[i] !== `${x.section}|${x.spans}|${x.role}|${x.style}|${x.translate}`) { structureChanged = true; break; }
      }
    }
    if (structureChanged || !changedIdx) this.paintAll();
    else for (const i of changedIdx) this.paintRow(i);
    this.updatePlaceholder();
  }

  // ------------------------------------------------------------------ painting
  hlHtml(text, style) {
    if (this.plain || !text) return esc(text);
    let out = '';
    for (const [t, c] of highlight(text, style)) out += c ? `<span class="h-${c}">${esc(t)}</span>` : esc(t);
    return out;
  }

  pillsHtml(tokens) {
    let out = '';
    tokens.forEach((t, k) => {
      const def = this.tagMap.get(t.name);
      const color = def?.color || '#64748b';
      const label = t.closing ? (t.name ? `/${t.name}` : '/END') : t.name;
      out += `<span class="pill${t.closing ? ' close' : ''}" data-k="${k}" style="--c:${esc(color)}" title="${esc(def?.description || 'Close the current block')}">${esc(label)}</span>`;
    });
    return out;
  }

  paintAll() {
    for (let i = 0; i < this.lines.length; i++) this.paintRow(i);
  }

  paintRow(i, force = false) {
    const line = this.lines[i];
    const info = this.info[i];
    const row = this.rowById.get(line.id);
    if (!row || !info) return;
    const tokSig = info.tokens.map((t) => (t.closing ? '/' : '') + t.name).join(',');
    const sig = `${info.role}|${info.section}|${info.spans}|${info.style}|${info.translate}|${info.md.heading}|${info.md.quote}|${info.color}|${tokSig}|${info.body}|${this.plain}`;
    if (force || row._sig !== sig) {
      row._sig = sig;
      row.dataset.role = info.role;
      row.dataset.style = info.style;
      if (info.md.heading) row.dataset.h = info.md.heading;
      else delete row.dataset.h;
      row.classList.toggle('insec', !!info.color);
      if (info.color) row.style.setProperty('--sec', info.color);
      else row.style.removeProperty('--sec');
      row.classList.toggle('quote', info.md.quote);
      row.classList.toggle('notr', !info.translate && info.role !== 'empty');
      if (row._src.pills._sig !== tokSig) {
        row._src.pills.innerHTML = this.pillsHtml(info.tokens);
        row._src.pills._sig = tokSig;
        row._src.pills.hidden = !info.tokens.length;
      }
      if (row._src.ta.value !== info.body) row._src.ta.value = info.body;
      row._src.hl.innerHTML = this.hlHtml(info.body, info.style);
    }
    this.paintTr(i, force);
  }

  trState(i) {
    const line = this.lines[i];
    const plan = this.plans[i];
    if (plan.mode === 'none') return 'none';
    if (plan.mode === 'copy') return 'copy';
    const key = this.keyFor(i);
    if (line.trManual) return line.trKey === key ? 'manual' : 'stale';
    if (line._pending) return line.tr ? 'pending' : 'wait';
    if (line._error) return 'error';
    if (line.trKey === key && line.tr) return 'ok';
    return 'todo';
  }

  paintTr(i, force = false) {
    const line = this.lines[i];
    const info = this.info[i];
    const plan = this.plans[i];
    const row = this.rowById.get(line.id);
    if (!row || !info) return;
    const state = this.trState(i);
    let text = '';
    let tokens = [];
    if (plan.mode === 'none') tokens = ROLE_MARKER.has(info.role) ? info.tokens : [];
    else {
      text = plan.mode === 'copy' ? info.body : line.tr || '';
      if (info.role === 'inline') tokens = info.tokens;
    }
    const tokSig = tokens.map((t) => (t.closing ? '/' : '') + t.name).join(',');
    const sig = `${state}|${text}|${tokSig}|${info.style}|${this.plain}|${line._error || ''}`;
    if (!force && row._trSig === sig) return;
    row._trSig = sig;
    row.dataset.tr = state;
    const t = row._tr;
    if (t.pills._sig !== tokSig) {
      t.pills.innerHTML = this.pillsHtml(tokens);
      t.pills._sig = tokSig;
      t.pills.hidden = !tokens.length;
    }
    t.ta.readOnly = plan.mode !== 'translate' || this.readOnly;
    if (t.ta.value !== text && document.activeElement !== t.ta) t.ta.value = text;
    t.hl.innerHTML = state === 'wait' ? esc('Translating…') : this.hlHtml(text, info.style);
    const st = t.st;
    const stIcon = { pending: 'loader', wait: 'loader', error: 'alert', stale: 'refresh', manual: 'pencil' }[state];
    st.innerHTML = stIcon ? icon(stIcon) : '';
    st.title = {
      pending: 'Translating…',
      wait: 'Translating…',
      error: `Translation failed: ${line._error || ''} — click to retry`,
      stale: 'Edited by hand, but the original changed since — click to translate again',
      manual: 'Edited by hand — click to restore the machine translation',
    }[state] || '';
  }

  updateGutter() {
    const digits = Math.max(2, String(this.lines.length).length);
    this.scroller.style.setProperty('--gw', `${digits * 7.4 + 18}px`);
  }

  updatePlaceholder() {
    const only = this.lines.length === 1 && !this.lines[0].text;
    const row = this.rowById.get(this.lines[0]?.id);
    if (!row) return;
    row._src.ta.placeholder = only ? 'Start typing… one line per row. Type / on an empty line for tags.' : '';
    row._tr.ta.placeholder = only ? 'The translation appears here, line by line.' : '';
  }

  // ------------------------------------------------------------------ translation hooks
  setPending(ids, on) {
    for (const id of ids) {
      const i = this.idx(id);
      if (i < 0) continue;
      this.lines[i]._pending = on;
      if (on) this.lines[i]._error = null;
      this.paintTr(i);
    }
  }

  setTranslation(id, { tr, trKey, trEngine }) {
    const i = this.idx(id);
    if (i < 0) return false;
    const line = this.lines[i];
    if (line.trManual) return false;
    line.tr = tr;
    line.trKey = trKey;
    line.trEngine = trEngine || '';
    line._pending = false;
    line._error = null;
    this.rememberTr(line);
    this.paintTr(i);
    return true;
  }

  setError(id, message) {
    const i = this.idx(id);
    if (i < 0) return;
    this.lines[i]._pending = false;
    this.lines[i]._error = message || 'Translation failed';
    this.paintTr(i);
  }

  /** Clear manual / stale state so the queue translates these lines again. */
  resetTranslations(ids) {
    for (const id of ids) {
      const i = this.idx(id);
      if (i < 0) continue;
      const l = this.lines[i];
      l.trManual = false;
      l.trKey = '';
      l._error = null;
      this.paintTr(i);
    }
  }

  clearTranslationsForMode() {
    // Lines that no longer need a translation drop their stale text.
    let changed = false;
    this.plans.forEach((p, i) => {
      const l = this.lines[i];
      if (p.mode !== 'translate' && (l.tr || l.trKey) && !l.trManual) {
        l.tr = '';
        l.trKey = '';
        l.trEngine = '';
        changed = true;
      }
    });
    return changed;
  }

  // ------------------------------------------------------------------ undo
  snapshot() {
    return { lines: this.lines.map((l) => [l.id, l.text]), focus: this.focusState() };
  }

  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  focusState() {
    const a = document.activeElement;
    if (a && a.classList?.contains('ta') && this.el.contains(a)) {
      return { id: a.closest('.row').dataset.id, pos: a.selectionStart, tr: !!a.closest('.cell.tr') };
    }
    return this.curId ? { id: this.curId, pos: 0 } : null;
  }

  restoreSnapshot(snap) {
    const old = new Map(this.lines.map((l) => [l.id, l]));
    this.lines = snap.lines.map(([id, text]) => {
      const prev = old.get(id);
      if (prev) {
        prev.text = text;
        return prev;
      }
      const mem = this.trMemory.get(id) || {};
      return { id, text, tr: mem.tr || '', trKey: mem.trKey || '', trEngine: mem.trEngine || '', trManual: !!mem.trManual };
    });
    this.structural();
    if (snap.focus) {
      const i = this.idx(snap.focus.id);
      if (i >= 0) this.focusLine(i, snap.focus.pos ?? 'end');
    }
    this.emit('change', { ids: this.lines.map((l) => l.id), structural: true });
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(this.redoStack.pop());
  }

  // ------------------------------------------------------------------ focus & navigation
  rowEl(i) {
    return this.rowById.get(this.lines[i]?.id);
  }

  focusLine(i, pos = 'end', which = 'src') {
    if (!this.lines.length) return;
    i = Math.max(0, Math.min(i, this.lines.length - 1));
    const row = this.rowEl(i);
    if (!row) return;
    const ta = which === 'tr' ? row._tr.ta : row._src.ta;
    ta.focus({ preventScroll: true });
    const p = pos === 'end' ? ta.value.length : Math.max(0, Math.min(pos, ta.value.length));
    try { ta.setSelectionRange(p, p); } catch { /* readonly */ }
    this.scrollIntoView(row);
  }

  scrollIntoView(row) {
    const sr = this.scroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const head = this.scroller.querySelector('.pane-head')?.offsetHeight || 0;
    if (rr.top < sr.top + head) this.scroller.scrollTop -= sr.top + head - rr.top + 6;
    else if (rr.bottom > sr.bottom) this.scroller.scrollTop += Math.min(rr.bottom - sr.bottom + 6, rr.top - sr.top - head);
  }

  currentIndex() {
    const i = this.curId ? this.idx(this.curId) : -1;
    return i >= 0 ? i : this.lines.length - 1;
  }

  caretLines(ta) {
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    if (ta.clientHeight < lh * 1.6) return { first: true, last: true };
    const hl = ta.parentElement.querySelector('.hl');
    const rect = caretRect(hl, ta.selectionStart);
    if (!rect) return { first: ta.selectionStart === 0, last: ta.selectionStart === ta.value.length };
    const hr = hl.getBoundingClientRect();
    return { first: rect.top - hr.top < lh * 0.7, last: hr.bottom - rect.bottom < lh * 1.2 };
  }

  // ------------------------------------------------------------------ edits
  /** Apply a change to one line's text and notify. */
  setLineText(i, text, { checkpoint = false } = {}) {
    if (checkpoint) this.checkpoint();
    this.lines[i].text = text;
    this.refresh([i]);
    this.emit('change', { ids: [this.lines[i].id] });
  }

  splitAt(i, start, end) {
    this.checkpoint();
    const line = this.lines[i];
    const info = this.info[i];
    const body = info.body;
    const before = body.slice(0, start);
    const after = body.slice(end);
    line.text = serializeLine(info.tokens, before);
    const nl = { id: newId(), text: after, tr: '', trKey: '', trEngine: '', trManual: false };
    this.lines.splice(i + 1, 0, nl);
    this.structural();
    this.focusLine(i + 1, 0);
    this.emit('change', { ids: [line.id, nl.id], structural: true });
  }

  backspaceAtStart(i) {
    const info = this.info[i];
    const line = this.lines[i];
    if (info.tokens.length) {
      this.checkpoint();
      line.text = serializeLine(info.tokens.slice(0, -1), info.body);
      this.refresh();
      this.focusLine(i, 0);
      this.emit('change', { ids: [line.id] });
      return;
    }
    if (i === 0) return;
    this.checkpoint();
    const prev = this.lines[i - 1];
    const prevInfo = this.info[i - 1];
    const caret = prevInfo.body.length;
    prev.text = prevInfo.tokens.length && !prevInfo.body ? serializeLine(prevInfo.tokens, line.text) : prev.text + line.text;
    this.lines.splice(i, 1);
    this.structural();
    this.focusLine(i - 1, caret);
    this.emit('change', { ids: [prev.id], structural: true });
  }

  deleteAtEnd(i) {
    if (i >= this.lines.length - 1) return;
    this.checkpoint();
    const line = this.lines[i];
    const info = this.info[i];
    const next = this.lines[i + 1];
    const caret = info.body.length;
    line.text = info.tokens.length && !info.body ? serializeLine(info.tokens, next.text) : line.text + next.text;
    this.lines.splice(i + 1, 1);
    this.structural();
    this.focusLine(i, caret);
    this.emit('change', { ids: [line.id], structural: true });
  }

  /** Replace line i's body range [start,end) with multi-line text. */
  insertMultiline(i, start, end, text) {
    this.checkpoint();
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const info = this.info[i];
    const body = info.body;
    const before = body.slice(0, start);
    const after = body.slice(end);
    this.lines[i].text = serializeLine(info.tokens, before + parts[0]);
    const added = parts.slice(1).map((t, k, arr) => ({
      id: newId(), text: k === arr.length - 1 ? t + after : t, tr: '', trKey: '', trEngine: '', trManual: false,
    }));
    this.lines.splice(i + 1, 0, ...added);
    this.structural();
    const lastIdx = i + added.length;
    this.focusLine(lastIdx, Math.max(0, this.info[lastIdx].body.length - after.length));
    this.emit('change', { ids: [this.lines[i].id, ...added.map((a) => a.id)], structural: true });
  }

  moveLines(from, to, dir) {
    if (dir < 0 && from === 0) return;
    if (dir > 0 && to >= this.lines.length - 1) return;
    this.checkpoint();
    const block = this.lines.splice(from, to - from + 1);
    this.lines.splice(from + dir, 0, ...block);
    this.structural();
    this.emit('change', { ids: block.map((l) => l.id), structural: true });
  }

  /** Replace every line from plain text (bulk mode); unchanged lines keep id + translation. */
  replaceAllTexts(texts) {
    this.checkpoint();
    const mapped = remapLines(this.lines, texts);
    this.lines = mapped.map(({ text, from }) => (from ? { ...from, text } : { id: newId(), text, tr: '', trKey: '', trEngine: '', trManual: false }));
    if (!this.lines.length) this.lines = [{ id: newId(), text: '', tr: '', trKey: '', trEngine: '', trManual: false }];
    this.structural();
    this.emit('change', { ids: this.lines.map((l) => l.id), structural: true });
  }

  // ------------------------------------------------------------------ tags
  insertTag(name, { atIndex } = {}) {
    const def = this.tagMap.get(name);
    if (!def) return;
    if (this.selection.size) return this.wrapSelection(name);
    const i = atIndex ?? this.currentIndex();
    const info = this.info[i];
    const line = this.lines[i];
    this.checkpoint();
    if (!info.body.trim() && def.kind !== 'line' && !info.tokens.length) {
      line.text = `[${name}]`;
      const mid = { id: newId(), text: '', tr: '', trKey: '', trEngine: '', trManual: false };
      const end = { id: newId(), text: `[/${name}]`, tr: '', trKey: '', trEngine: '', trManual: false };
      this.lines.splice(i + 1, 0, mid, end);
      this.structural();
      this.focusLine(i + 1, 0);
      this.emit('change', { ids: [line.id, mid.id, end.id], structural: true });
      return;
    }
    if (!info.tokens.some((t) => t.name === name && !t.closing)) {
      line.text = serializeLine([...info.tokens, { name, closing: false }], info.body);
    }
    this.refresh();
    this.focusLine(i, 'end');
    this.emit('change', { ids: [line.id] });
  }

  wrapSelection(name) {
    const def = this.tagMap.get(name);
    const idxs = this.selectedIndexes();
    if (!idxs.length || !def) return;
    this.checkpoint();
    if (def.kind === 'line') {
      for (const i of idxs) {
        const info = this.info[i];
        if (!info.tokens.some((t) => t.name === name)) this.lines[i].text = serializeLine([...info.tokens, { name, closing: false }], info.body);
      }
      this.refresh();
    } else {
      const first = idxs[0];
      const last = idxs[idxs.length - 1];
      const open = { id: newId(), text: `[${name}]`, tr: '', trKey: '', trEngine: '', trManual: false };
      const close = { id: newId(), text: `[/${name}]`, tr: '', trKey: '', trEngine: '', trManual: false };
      this.lines.splice(last + 1, 0, close);
      this.lines.splice(first, 0, open);
      this.structural();
    }
    this.clearSelection();
    this.emit('change', { ids: this.lines.map((l) => l.id), structural: true });
  }

  removeToken(i, k) {
    const info = this.info[i];
    this.checkpoint();
    const tokens = info.tokens.filter((_, j) => j !== k);
    this.lines[i].text = serializeLine(tokens, info.body);
    this.refresh();
    this.emit('change', { ids: [this.lines[i].id] });
  }

  replaceToken(i, k, name) {
    const info = this.info[i];
    this.checkpoint();
    const tokens = info.tokens.map((t, j) => (j === k ? { ...t, name } : t));
    this.lines[i].text = serializeLine(tokens, info.body);
    this.refresh();
    this.emit('change', { ids: [this.lines[i].id] });
  }

  /** Insert a closing tag at the end of the block opened on line i. */
  closeBlockAt(i, name) {
    let j = i + 1;
    while (j < this.lines.length && this.info[j].role !== 'open' && !(this.info[j].role === 'close')) j++;
    this.checkpoint();
    const close = { id: newId(), text: `[/${name}]`, tr: '', trKey: '', trEngine: '', trManual: false };
    this.lines.splice(j, 0, close);
    this.structural();
    this.emit('change', { ids: [close.id], structural: true });
  }

  // ------------------------------------------------------------------ selection (gutter)
  selectedIndexes() {
    return [...this.selection].map((id) => this.idx(id)).filter((i) => i >= 0).sort((a, b) => a - b);
  }

  paintSelection() {
    for (const [id, row] of this.rowById) row.classList.toggle('sel', this.selection.has(id));
    this.emit('selection', { count: this.selection.size });
  }

  selectRange(a, b) {
    const [from, to] = a < b ? [a, b] : [b, a];
    this.selection = new Set(this.lines.slice(from, to + 1).map((l) => l.id));
    this.paintSelection();
  }

  selectAll() {
    this.selAnchor = 0;
    this.selectRange(0, this.lines.length - 1);
    this.el.focus({ preventScroll: true });
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.paintSelection();
  }

  selectedText(withTranslation = false) {
    return this.selectedIndexes().map((i) => {
      if (!withTranslation) return this.lines[i].text;
      const p = this.plans[i];
      const tr = p.mode === 'copy' ? this.info[i].body : p.mode === 'translate' ? this.lines[i].tr : '';
      return `${this.lines[i].text}\t${tr || ''}`;
    }).join('\n');
  }

  deleteSelected() {
    const idxs = this.selectedIndexes();
    if (!idxs.length) return;
    this.checkpoint();
    const gone = new Set(idxs.map((i) => this.lines[i].id));
    this.lines = this.lines.filter((l) => !gone.has(l.id));
    if (!this.lines.length) this.lines = [{ id: newId(), text: '', tr: '', trKey: '', trEngine: '', trManual: false }];
    this.selection.clear();
    this.structural();
    this.paintSelection();
    this.focusLine(Math.min(idxs[0], this.lines.length - 1), 0);
    this.emit('change', { ids: [], structural: true });
  }

  // ------------------------------------------------------------------ events
  bind() {
    const el = this.el;
    el.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    el.addEventListener('input', (e) => this.onInput(e));
    el.addEventListener('keydown', (e) => this.onKeyDown(e));
    el.addEventListener('paste', (e) => this.onPaste(e));
    el.addEventListener('compositionstart', () => { this.composing = true; });
    el.addEventListener('compositionend', () => { this.composing = false; });
    el.addEventListener('focusin', (e) => {
      const row = e.target.closest?.('.row');
      if (!row) return;
      if (this.curId !== row.dataset.id) {
        this.rowById.get(this.curId)?.classList.remove('cur');
        this.curId = row.dataset.id;
        row.classList.add('cur');
        this.emit('cursor', { id: this.curId, index: this.idx(this.curId) });
      }
      if (e.target.classList.contains('ta')) this.clearSelection();
    });
    el.addEventListener('focusout', (e) => {
      if (!el.contains(e.relatedTarget)) this.rowById.get(this.curId)?.classList.remove('cur');
    });
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (pill) {
        const row = pill.closest('.row');
        this.emit('pill', { index: this.idx(row.dataset.id), k: Number(pill.dataset.k), anchor: pill, side: pill.closest('.cell.tr') ? 'tr' : 'src' });
        return;
      }
      const st = e.target.closest('.tr-st');
      if (st) {
        const row = st.closest('.row');
        this.emit('status', { index: this.idx(row.dataset.id), anchor: st });
      }
    });
  }

  rowOf(target) {
    const row = target.closest?.('.row');
    if (!row) return null;
    const i = this.idx(row.dataset.id);
    return i < 0 ? null : { row, i };
  }

  onPointerDown(e) {
    const g = e.target.closest('.ln');
    if (!g) return;
    const r = this.rowOf(g);
    if (!r) return;
    e.preventDefault();
    const id = this.lines[r.i].id;
    if (e.shiftKey && this.selAnchor >= 0) this.selectRange(this.selAnchor, r.i);
    else if (e.ctrlKey || e.metaKey) {
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
      this.selAnchor = r.i;
      this.paintSelection();
    } else {
      this.selAnchor = r.i;
      this.selectRange(r.i, r.i);
    }
    this.el.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') {
      const move = (ev) => {
        const t = document.elementFromPoint(ev.clientX, ev.clientY);
        const rr = t && this.rowOf(t);
        if (rr) this.selectRange(this.selAnchor, rr.i);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
  }

  onBeforeInput(e) {
    const ta = e.target;
    if (!ta.classList?.contains('ta')) return;
    const t = e.inputType || '';
    if (t === 'historyUndo') { e.preventDefault(); this.undo(); return; }
    if (t === 'historyRedo') { e.preventDefault(); this.redo(); return; }
    const r = this.rowOf(ta);
    if (!r) return;
    const isTr = !!ta.closest('.cell.tr');
    if (!isTr && (t === 'insertParagraph' || t === 'insertLineBreak')) {
      e.preventDefault();
      this.splitAt(r.i, ta.selectionStart, ta.selectionEnd);
      return;
    }
    if (isTr) return;
    const now = Date.now();
    const del = t.startsWith('delete');
    const id = this.lines[r.i].id;
    if (now - this.lastInput.at > 1200 || this.lastInput.id !== id || del !== this.lastInput.del) this.checkpoint();
    this.lastInput = { at: now, id, del };
  }

  onInput(e) {
    const ta = e.target;
    if (!ta.classList?.contains('ta')) return;
    const r = this.rowOf(ta);
    if (!r) return;
    const { i } = r;
    const line = this.lines[i];
    if (ta.closest('.cell.tr')) {
      line.tr = ta.value.replace(/\n/g, ' ');
      line.trManual = !!line.tr;
      if (!line.tr) line.trKey = '';
      line.trKey ||= this.keyFor(i);
      this.rememberTr(line);
      this.paintTr(i);
      this.emit('trchange', { id: line.id, cleared: !line.tr });
      return;
    }
    let body = ta.value;
    const info = this.info[i];
    if (body.includes('\n')) {
      // A line break slipped past beforeinput (some IMEs): split here, keep the caret where it was.
      const caret = ta.selectionStart;
      const parts = `${body.slice(0, caret)}\u0000${body.slice(caret)}`.split('\n');
      const k = parts.findIndex((p) => p.includes('\u0000'));
      const pos = parts[k].indexOf('\u0000');
      const clean = parts.map((p) => p.replace('\u0000', ''));
      this.checkpoint();
      line.text = serializeLine(info.tokens, clean[0]);
      const added = clean.slice(1).map((t) => ({ id: newId(), text: t, tr: '', trKey: '', trEngine: '', trManual: false }));
      this.lines.splice(i + 1, 0, ...added);
      this.structural();
      this.focusLine(i + k, pos);
      this.emit('change', { ids: [line.id, ...added.map((a) => a.id)], structural: true });
      return;
    }
    let tokens = info.tokens;
    let caret = ta.selectionStart;
    if (/^\s*\[/.test(body)) {
      const p = parseLine(body, this.tagMap);
      if (p.tokens.length) {
        tokens = [...tokens, ...p.tokens];
        body = p.body;
        caret = Math.max(0, caret - p.prefixLen);
        ta.value = body;
        ta.setSelectionRange(caret, caret);
      }
    }
    if (tokens.length && body === ' ' && info.body === '') {
      body = '';
      ta.value = '';
    }
    line.text = serializeLine(tokens, body);
    this.refresh([i]);
    this.emit('change', { ids: [line.id] });
    // Slash command: "/" (+ filter) on an otherwise empty, untagged line.
    if (!tokens.length && /^\/[\w-]{0,24}$/.test(body) && caret === body.length) {
      this.slashActive = line.id;
      this.emit('slash', { index: i, query: body.slice(1), anchor: ta });
    } else if (this.slashActive) {
      this.slashActive = null;
      this.emit('slashclose');
    }
  }

  /** Called by the app when a tag was chosen from the slash menu. */
  applySlash(name) {
    const i = this.idx(this.slashActive);
    this.slashActive = null;
    if (i < 0) return;
    this.lines[i].text = '';
    this.refresh([i]);
    this.insertTag(name, { atIndex: i });
  }

  onPaste(e) {
    const ta = e.target;
    if (!ta.classList?.contains('ta') || ta.closest('.cell.tr')) return;
    const text = e.clipboardData?.getData('text/plain');
    if (text == null || !/[\r\n]/.test(text)) return;
    e.preventDefault();
    const r = this.rowOf(ta);
    if (r) this.insertMultiline(r.i, ta.selectionStart, ta.selectionEnd, text.replace(/[\r\n]+$/, ''));
  }

  onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    const ta = e.target.classList?.contains('ta') ? e.target : null;
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (!ta) return this.onSelectionKey(e);
    const r = this.rowOf(ta);
    if (!r) return;
    const { i } = r;
    if (mod && (e.key === 'a' || e.key === 'A') && ta.selectionStart === 0 && ta.selectionEnd === ta.value.length) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    if (this.slashActive && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      this.emit('slashkey', { key: e.key });
      return;
    }
    const isTr = !!ta.closest('.cell.tr');
    const which = isTr ? 'tr' : 'src';
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (mod) this.emit('flush');
        else if (isTr) this.focusLine(i + 1, 'end', 'tr');
        else this.splitAt(i, ta.selectionStart, ta.selectionEnd);
        return;
      case 'Backspace':
        if (!isTr && atStart) {
          e.preventDefault();
          this.backspaceAtStart(i);
        }
        return;
      case 'Delete':
        if (!isTr && atEnd && ta.value.length === ta.selectionEnd) {
          e.preventDefault();
          this.deleteAtEnd(i);
        }
        return;
      case 'ArrowUp':
        if (e.altKey && !isTr) {
          e.preventDefault();
          const pos = ta.selectionStart;
          this.moveLines(i, i, -1);
          this.focusLine(i - 1, pos);
          return;
        }
        if (e.shiftKey || i === 0) return;
        if (this.caretLines(ta).first) {
          e.preventDefault();
          this.focusLine(i - 1, Math.min(ta.selectionStart, this.rowEl(i - 1)?.[which === 'tr' ? '_tr' : '_src'].ta.value.length ?? 0), which);
        }
        return;
      case 'ArrowDown':
        if (e.altKey && !isTr) {
          e.preventDefault();
          const pos = ta.selectionStart;
          this.moveLines(i, i, 1);
          this.focusLine(i + 1, pos);
          return;
        }
        if (e.shiftKey || i === this.lines.length - 1) return;
        if (this.caretLines(ta).last) {
          e.preventDefault();
          this.focusLine(i + 1, Math.min(ta.selectionStart, this.rowEl(i + 1)?.[which === 'tr' ? '_tr' : '_src'].ta.value.length ?? 0), which);
        }
        return;
      case 'ArrowLeft':
        if (!e.shiftKey && atStart && i > 0) {
          e.preventDefault();
          this.focusLine(i - 1, 'end', which);
        }
        return;
      case 'ArrowRight':
        if (!e.shiftKey && atEnd && i < this.lines.length - 1) {
          e.preventDefault();
          this.focusLine(i + 1, 0, which);
        }
        return;
      case 'Home':
        if (mod) { e.preventDefault(); this.focusLine(0, 0, which); }
        return;
      case 'End':
        if (mod) { e.preventDefault(); this.focusLine(this.lines.length - 1, 'end', which); }
        return;
      case 'Escape':
        if (isTr) this.focusLine(i, 'end', 'src');
        return;
      default:
    }
  }

  onSelectionKey(e) {
    if (!this.selection.size) return;
    const mod = e.ctrlKey || e.metaKey;
    const idxs = this.selectedIndexes();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.clearSelection();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelected();
    } else if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.selectAll();
    } else if (mod && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      this.emit('copylines', { text: this.selectedText(e.shiftKey), cut: e.key.toLowerCase() === 'x' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = idxs[0];
      this.clearSelection();
      this.focusLine(first, 'end');
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const contiguous = idxs[idxs.length - 1] - idxs[0] === idxs.length - 1;
      if (contiguous) {
        const ids = idxs.map((k) => this.lines[k].id);
        this.moveLines(idxs[0], idxs[idxs.length - 1], dir);
        this.selection = new Set(ids);
        this.paintSelection();
      }
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
      e.preventDefault();
      const edge = e.key === 'ArrowUp' ? Math.max(0, idxs[0] - 1) : Math.min(this.lines.length - 1, idxs[idxs.length - 1] + 1);
      this.selectRange(this.selAnchor >= 0 ? this.selAnchor : idxs[0], edge);
    }
  }
}
