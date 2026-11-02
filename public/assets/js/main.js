// CleanTranslate editor — application shell.
import { api } from './api.js';
import { Editor } from './editor.js';
import { TranslationQueue } from './translate-queue.js';
import { NoteSync } from './sync.js';
import { prefs } from './prefs.js';
import { LANGUAGES, languageName } from '../../shared/languages.js';
import { serializeLine, planKey, planLine, analyze } from '../../shared/markup.js';
import {
  $, $$, esc, debounce, timeAgo, fmtNum, toast, openMenu, openPopover, closePopover, isPopoverOpen, openModal,
  confirmDialog, copyText,
} from './ui.js';
import { icon, hydrateIcons, setIcon } from './icons.js';

const S = {
  config: null,
  note: null,
  notes: [],
  detected: null,
  bulk: false,
  engineWarn: '',
  lastErrorToast: 0,
};

let editor;
let queue;
let sync;

const app = $('#app');
const rowsEl = $('#rows');
const paneHead = $('#pane-head');
const scroller = $('#scroller');

// ------------------------------------------------------------------ boot
async function boot() {
  hydrateIcons();
  const params = new URLSearchParams(location.search);
  if (params.get('embed') === '1') app.classList.add('embed');
  try {
    S.config = await api.get('api/config');
  } catch (e) {
    document.body.innerHTML = `<div style="padding:32px;font:15px system-ui;max-width:560px;margin:auto"><h2>Cannot reach the CleanTranslate server</h2><p>${esc(e.message)}</p><p><button id="boot-retry" class="btn">Retry</button></p></div>`;
    document.getElementById('boot-retry').addEventListener('click', () => location.reload());
    return;
  }
  document.title = S.config.instanceName;
  if (!S.config.adminEnabled) $('#lnk-admin').hidden = true;
  prefs.init(S.config.ui);
  editor = new Editor({ rowsEl, scroller, tags: S.config.tags });
  queue = new TranslationQueue(editor, { getState: queueState });
  sync = new NoteSync({ getPayload, delay: S.config.autosaveDelayMs });
  fillLanguageSelects();
  fillEngineSelect();
  applyPrefs();
  wireEditor();
  wireQueue();
  wireSync();
  wireToolbar();
  wireDrawer();
  wireSelectionBar();
  wireSplit();
  wireKeyboard();
  wireViewport();
  await refreshNoteList();
  if (params.get('new') === '1') {
    await createNote();
  } else {
    const wanted = noteIdFromUrl() || params.get('note') || prefs.get('lastNote');
    await openNote(wanted, { fallback: true });
  }
  app.dataset.loading = '0';
  setInterval(refreshEnginesQuietly, 60_000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function queueState() {
  const n = S.note;
  const engines = S.config.engines;
  const sel = engines.find((e) => e.id === n?.engine);
  const browser = engines.find((e) => e.type === 'google-browser');
  return {
    source: n?.sourceLang || 'auto',
    target: n?.targetLang,
    engine: n?.engine || 'auto',
    engineIsBrowser: sel?.type === 'google-browser',
    browserEngineId: browser?.id || null,
    browserFallback: S.config.browserFallback && !!browser,
    paused: !prefs.get('showTranslation') || S.bulk,
    delay: S.config.translateDelayMs,
  };
}

function getPayload() {
  return {
    title: S.note.title,
    sourceLang: S.note.sourceLang,
    targetLang: S.note.targetLang,
    engine: S.note.engine,
    lines: editor.serialize(),
  };
}

// ------------------------------------------------------------------ routing
function basePath() {
  return new URL(document.baseURI).pathname;
}

function noteIdFromUrl() {
  const rel = location.pathname.startsWith(basePath()) ? location.pathname.slice(basePath().length) : '';
  const m = /^n\/([A-Za-z0-9_-]+)/.exec(rel);
  return m ? m[1] : null;
}

function setUrl(id) {
  const qs = new URLSearchParams(location.search);
  qs.delete('note');
  qs.delete('new');
  const q = qs.toString();
  const url = `${basePath()}n/${id}${q ? `?${q}` : ''}`;
  if (location.pathname + location.search !== url) history.replaceState(null, '', url);
}

// ------------------------------------------------------------------ notes
async function refreshNoteList(q = $('#note-search').value.trim()) {
  try {
    const r = await api.get(`api/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    S.notes = r.notes;
    renderNoteList();
  } catch { /* offline: keep old list */ }
}

function renderNoteList() {
  const ul = $('#note-list');
  if (!S.notes.length) {
    ul.innerHTML = `<li class="note-empty">${$('#note-search').value ? 'No matching notes' : 'No notes yet'}</li>`;
    return;
  }
  ul.innerHTML = S.notes.map((n) => `
    <li class="note-item${n.id === S.note?.id ? ' active' : ''}" data-id="${esc(n.id)}" tabindex="0">
      <span class="ni-title">${n.pinned ? `<span class="pin">${icon('pin')}</span> ` : ''}${esc(n.title || n.preview.split(' · ')[0] || 'Untitled')}</span>
      <button class="icon-btn ni-menu" data-menu data-icon="more" title="Note actions"></button>
      <span class="ni-preview">${esc(n.preview || 'Empty note')}</span>
      <span class="ni-meta"><span>${esc(timeAgo(n.updatedAt))}</span><span>·</span><span>${n.lineCount} lines</span><span>·</span><span>${esc(n.sourceLang)}→${esc(n.targetLang)}</span></span>
    </li>`).join('');
  hydrateIcons(ul);
}

async function createNote(fields = {}) {
  await sync.flush().catch(() => {});
  const src = prefs.get('lastSource') || S.config.defaults.source;
  const tgt = prefs.get('lastTarget') || S.config.defaults.target;
  const eng = prefs.get('lastEngine') || S.config.defaults.engine;
  const n = await api.post('api/notes', { sourceLang: src, targetLang: tgt, engine: eng, ...fields });
  await openNote(n.id, { note: n });
  refreshNoteList();
  return n;
}

async function openNote(id, { fallback = false, note = null } = {}) {
  if (sync.noteId && sync.noteId !== id) await sync.flush().catch(() => {});
  let n = note;
  if (!n && id) {
    try {
      n = await api.get(`api/notes/${id}`);
    } catch (e) {
      if (!fallback) {
        toast(e.status === 404 ? 'That note was not found' : e.message, { type: 'error' });
        return;
      }
    }
  }
  if (!n && fallback) {
    if (S.notes.length) {
      try { n = await api.get(`api/notes/${S.notes[0].id}`); } catch { /* fall through */ }
    }
    if (!n) {
      const src = prefs.get('lastSource') || S.config.defaults.source;
      const tgt = prefs.get('lastTarget') || S.config.defaults.target;
      n = await api.post('api/notes', { sourceLang: src, targetLang: tgt, engine: prefs.get('lastEngine') || S.config.defaults.engine, lines: welcomeLines() });
      refreshNoteList();
    }
  }
  if (!n) return;
  queue.reset();
  // Unsynced local changes from a previous session?
  const pend = NoteSync.pendingFor(n.id);
  let recovered = false;
  if (pend?.payload?.lines) {
    if (pend.baseVersion === n.version) {
      Object.assign(n, pend.payload);
      recovered = true;
    } else if (pend.savedAt > n.updatedAt - 1000) {
      const keepLocal = await confirmDialog('Unsaved changes found',
        `This device has changes from ${timeAgo(pend.savedAt)} that never reached the server, but the note was also changed elsewhere. Keep this device's version?`,
        { ok: 'Keep this device\'s version' });
      if (keepLocal) {
        Object.assign(n, pend.payload);
        recovered = 'force';
      } else NoteSync.prototype.clearBackup.call({ noteId: n.id }, n.id);
    } else {
      NoteSync.prototype.clearBackup.call({ noteId: n.id }, n.id);
    }
  }
  S.note = n;
  S.detected = null;
  editor.setLangs(n.sourceLang, n.targetLang);
  editor.load(n.lines);
  sync.attach(n);
  prefs.set('lastNote', n.id);
  setUrl(n.id);
  syncHeader();
  renderNoteList();
  updateStatus();
  if (recovered) {
    sync.markDirty('orig');
    if (recovered === 'force') sync.save({ force: true });
    toast('Recovered unsaved changes from this device');
  }
  queue.schedule(60);
  if (window.matchMedia('(max-width: 1099px)').matches) setDrawer(false);
}

function welcomeLines() {
  return [
    '# Welcome to CleanTranslate',
    'Type on the left, one line per row. The translation appears on the right, always on the same line.',
    'Only the lines you change are sent to the translator.',
    '',
    '[DIALOG]',
    'Ana: Good morning! How are you today?',
    'Tom: Very well, thank you. And you?',
    '[/DIALOG]',
    '',
    '[VOCABULARY]',
    'breakfast - the first meal of the day',
    'to borrow - to take something and give it back later',
    '[/VOCABULARY]',
    '',
    '[NOTRANSLATE] Names, codes or anything in `backticks` are kept as they are.',
    'Type / on an empty line to insert a tag, or use the Tags button.',
  ];
}

async function deleteNote(id) {
  const n = S.notes.find((x) => x.id === id) || S.note;
  const ok = await confirmDialog('Move note to trash?', `"${n?.title || 'Untitled'}" can be restored from the admin dashboard for a while.`, { ok: 'Move to trash', danger: true });
  if (!ok) return;
  await api.del(`api/notes/${id}`);
  toast('Note moved to trash', {
    action: 'Undo',
    onAction: async () => {
      await api.post(`api/notes/${id}/restore`);
      await refreshNoteList();
      openNote(id);
    },
  });
  await refreshNoteList();
  if (S.note?.id === id) {
    sync.noteId = null;
    await openNote(S.notes[0]?.id, { fallback: true });
  }
}

async function duplicateNote(id) {
  await sync.flush().catch(() => {});
  const n = await api.post(`api/notes/${id}/duplicate`);
  await refreshNoteList();
  openNote(n.id, { note: n });
}

async function togglePin(id) {
  const n = S.notes.find((x) => x.id === id);
  await api.patch(`api/notes/${id}`, { pinned: !n?.pinned });
  if (S.note?.id === id) {
    const fresh = await api.get(`api/notes/${id}`);
    sync.version = fresh.version;
    S.note.version = fresh.version;
  }
  refreshNoteList();
}

// ------------------------------------------------------------------ header, languages, engines
function fillLanguageSelects() {
  const opts = LANGUAGES.map((l) => `<option value="${l.code}">${esc(l.name)}${l.native !== l.name ? ` · ${esc(l.native)}` : ''}</option>`).join('');
  $('#sel-source').innerHTML = `<option value="auto">Detect language</option>${opts}`;
  $('#sel-target').innerHTML = opts;
}

function fillEngineSelect() {
  const sel = $('#sel-engine');
  const engines = S.config.engines;
  sel.innerHTML = `<option value="auto">Auto engine</option>${engines.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}${e.coolingDown ? ' (paused)' : ''}</option>`).join('')}`;
  if (S.note) sel.value = engines.some((e) => e.id === S.note.engine) ? S.note.engine : 'auto';
}

async function refreshEnginesQuietly() {
  try {
    const c = await api.get('api/config');
    S.config.engines = c.engines;
    if (JSON.stringify(c.tags) !== JSON.stringify(S.config.tags)) {
      S.config.tags = c.tags;
      editor.setTags(c.tags);
    }
    fillEngineSelect();
    updateStatus();
  } catch { /* offline */ }
}

function updateTitlePlaceholder() {
  const first = editor.info.find((x) => (x.role === 'text' || x.role === 'inline') && x.body.trim());
  $('#note-title').placeholder = first ? first.body.slice(first.md.prefix.length).trim().slice(0, 80) : 'Untitled note';
}

function syncHeader() {
  const n = S.note;
  $('#note-title').value = n.title || '';
  updateTitlePlaceholder();
  $('#sel-source').value = n.sourceLang;
  $('#sel-target').value = n.targetLang;
  fillEngineSelect();
  updatePaneHead();
}

function updatePaneHead() {
  const n = S.note;
  if (!n) return;
  $('#ph-src-lang').textContent = n.sourceLang === 'auto' ? (S.detected ? languageName(S.detected) : 'Original') : languageName(n.sourceLang);
  $('#ph-detected').textContent = n.sourceLang === 'auto' ? (S.detected ? 'detected' : 'auto-detect') : '';
  $('#ph-tr-lang').textContent = languageName(n.targetLang);
}

function setMeta(fields) {
  Object.assign(S.note, fields);
  sync.markDirty('meta');
}

function onLangChange(which, value) {
  if (which === 'source') {
    S.note.sourceLang = value;
    prefs.set('lastSource', value);
  } else {
    S.note.targetLang = value;
    prefs.set('lastTarget', value);
  }
  if (S.note.sourceLang !== 'auto' && S.note.sourceLang === S.note.targetLang) toast('Source and target language are the same', { type: 'warn' });
  editor.setLangs(S.note.sourceLang, S.note.targetLang);
  setMeta({});
  updatePaneHead();
  queue.schedule(0);
  updateStatus();
}

function swapLanguages() {
  const n = S.note;
  const src = n.sourceLang === 'auto' ? S.detected : n.sourceLang;
  if (!src) {
    toast('Pick a source language first (nothing detected yet)', { type: 'warn' });
    return;
  }
  const hasText = editor.lines.some((l) => l.text.trim());
  const swapLangsOnly = () => {
    $('#sel-source').value = n.targetLang;
    $('#sel-target').value = src;
    n.sourceLang = n.targetLang;
    n.targetLang = src;
    prefs.set('lastSource', n.sourceLang);
    prefs.set('lastTarget', n.targetLang);
    editor.setLangs(n.sourceLang, n.targetLang);
    setMeta({});
    updatePaneHead();
    queue.schedule(0);
  };
  if (!hasText) return swapLangsOnly();
  openMenu($('#btn-swap'), [
    { label: 'Swap languages and text', icon: 'swap', desc: 'Translations become the original (like Google Translate)', onClick: () => swapText(src) },
    { label: 'Swap languages only', icon: 'globe', desc: 'Keep the text, change the declared languages', onClick: swapLangsOnly },
  ]);
}

function swapText(src) {
  const n = S.note;
  const missing = editor.lines.filter((l, i) => editor.plans[i].mode === 'translate' && !l.tr).length;
  if (missing) {
    toast(`${missing} line(s) are not translated yet — wait for them and try again`, { type: 'warn' });
    return;
  }
  editor.checkpoint();
  const newSrc = n.targetLang;
  const newTgt = src;
  const oldInfo = editor.info;
  const swapped = editor.lines.map((l, i) => {
    const inf = oldInfo[i];
    const p = editor.plans[i];
    if (p.mode !== 'translate') return { ...l };
    return { ...l, text: serializeLine(inf.tokens, l.tr), tr: inf.body, trManual: false };
  });
  const info = analyze(swapped.map((l) => l.text), editor.tagMap);
  swapped.forEach((l, i) => {
    const p = planLine(info[i]);
    l.trKey = p.mode === 'translate' ? planKey(p, newSrc, newTgt) : '';
    if (p.mode !== 'translate') l.tr = '';
  });
  n.sourceLang = newSrc;
  n.targetLang = newTgt;
  $('#sel-source').value = newSrc;
  $('#sel-target').value = newTgt;
  editor.setLangs(newSrc, newTgt);
  editor.load(swapped);
  sync.markDirty('orig');
  updatePaneHead();
  updateStatus();
  toast('Languages and text swapped');
}

// ------------------------------------------------------------------ prefs / view
function applyPrefs() {
  const p = prefs.all();
  document.documentElement.dataset.theme = p.theme;
  rowsEl.classList.toggle('no-numbers', !p.lineNumbers);
  paneHead.classList.toggle('no-numbers', !p.lineNumbers);
  rowsEl.classList.toggle('zebra', p.zebra);
  rowsEl.classList.toggle('plain', !p.highlight);
  if (editor && editor.plain !== !p.highlight) editor.setPlain(!p.highlight);
  const showTr = p.showTranslation;
  rowsEl.classList.toggle('no-tr', !showTr);
  paneHead.classList.toggle('no-tr', !showTr);
  setPressed('#tg-numbers', p.lineNumbers);
  setPressed('#tg-zebra', p.zebra);
  setPressed('#tg-highlight', p.highlight);
  setPressed('#tg-translation', showTr);
  setIcon($('#tg-translation'), showTr ? 'eye' : 'eyeOff');
  scroller.style.setProperty('--fs', `${p.fontSize}px`);
  scroller.style.setProperty('--lh', String(p.lineHeight));
  scroller.style.setProperty('--font-text', p.font === 'serif' ? 'var(--font-serif)' : p.font === 'mono' ? 'var(--font-mono)' : 'var(--font-ui)');
  applySplit(p.split);
  applyLayout();
}

function setPressed(sel, on) {
  $(sel).setAttribute('aria-pressed', on ? 'true' : 'false');
}

function applySplit(split) {
  const s = Math.max(0.2, Math.min(0.8, split || 0.5));
  scroller.style.setProperty('--split', String(s));
  scroller.style.setProperty('--l', `${Math.round(s * 1000)}fr`);
  scroller.style.setProperty('--r', `${Math.round((1 - s) * 1000)}fr`);
}

function effectiveLayout() {
  const pref = prefs.get('layout');
  if (pref !== 'auto') return pref;
  return scroller.clientWidth < 640 ? 'stacked' : 'side';
}

function applyLayout() {
  const lay = effectiveLayout();
  rowsEl.classList.toggle('stacked', lay === 'stacked');
  paneHead.classList.toggle('stacked', lay === 'stacked');
  const pref = prefs.get('layout');
  setIcon($('#tg-layout'), lay === 'stacked' ? 'rowsIcon' : 'columns');
  $('#tg-layout').title = `Layout: ${pref === 'auto' ? `automatic (${lay === 'stacked' ? 'stacked' : 'side by side'})` : lay === 'stacked' ? 'stacked' : 'side by side'} — click to change`;
}

function toggleTranslationPane(force) {
  const v = force ?? !prefs.get('showTranslation');
  prefs.set('showTranslation', v);
  applyPrefs();
  if (v) queue.schedule(0);
  updateStatus();
}

function cycleLayout() {
  const order = ['auto', 'side', 'stacked'];
  const next = order[(order.indexOf(prefs.get('layout')) + 1) % order.length];
  prefs.set('layout', next);
  applyLayout();
  toast(`Layout: ${next === 'auto' ? 'automatic (stacked on narrow screens)' : next === 'side' ? 'side by side' : 'stacked (translation under each line)'}`, { timeout: 2000 });
}

async function toggleFullscreen() {
  const on = !app.classList.contains('focus');
  app.classList.toggle('focus', on);
  try {
    if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* not allowed (iOS): focus mode still maximizes the editor */ }
  setIcon($('#btn-fullscreen'), on ? 'minimize' : 'maximize');
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && app.classList.contains('focus')) {
    app.classList.remove('focus');
    setIcon($('#btn-fullscreen'), 'maximize');
  }
});

// ------------------------------------------------------------------ status
const updateStatus = debounce(() => {
  if (!S.note || !editor) return;
  const lines = editor.lines.length;
  let chars = 0;
  let need = 0;
  let have = 0;
  editor.lines.forEach((l, i) => {
    chars += l.text.length;
    if (editor.plans[i]?.mode === 'translate') {
      need++;
      if (l.tr && (l.trManual || l.trKey === editor.keyFor(i))) have++;
    }
  });
  $('#st-lines').textContent = `${fmtNum(lines)} line${lines === 1 ? '' : 's'}`;
  $('#st-chars').textContent = `${fmtNum(chars)} chars`;
  $('#st-translated').textContent = `${have}/${need} translated`;
  const pending = queue.pendingCount();
  const prog = $('#ph-progress');
  if (!prefs.get('showTranslation')) prog.textContent = '';
  else if (pending) {
    prog.textContent = `translating ${pending}…`;
    prog.classList.add('busy');
  } else {
    prog.classList.remove('busy');
    prog.textContent = need && have === need ? '' : need - have ? `${need - have} waiting` : '';
  }
  const eng = S.config.engines.find((e) => e.id === S.note.engine);
  const engName = eng ? eng.name : 'Auto engine';
  const cooling = S.config.engines.filter((e) => e.coolingDown && e.inAuto).map((e) => e.name);
  const st = $('#st-engine');
  st.textContent = S.engineWarn ? `${engName} · ${S.engineWarn}` : cooling.length && !eng ? `${engName} · paused: ${cooling.join(', ')}` : engName;
  st.classList.toggle('warn', !!S.engineWarn);
}, 120);

function setSaveState(state, message) {
  const el = $('#save-state');
  el.dataset.state = state;
  const map = {
    saved: ['check', 'Saved', 'All changes saved'],
    dirty: ['cloud', '', 'Unsaved changes'],
    saving: ['cloud', 'Saving…', 'Saving…'],
    offline: ['cloudOff', 'Offline', `Offline — changes are kept on this device and will be sent when the server is reachable. ${message || ''}`],
    error: ['alert', 'Not saved', message || 'Could not save'],
    conflict: ['alert', 'Conflict', 'Changed elsewhere — click to resolve'],
  };
  const [ic, label, title] = map[state] || map.saved;
  const showLabel = ['offline', 'error', 'conflict'].includes(state);
  el.innerHTML = `${icon(ic)}${showLabel ? `<span class="lbl">${esc(label)}</span>` : ''}`;
  el.title = title;
}

// ------------------------------------------------------------------ wiring: editor, queue, sync
const updatePlaceholderSoon = debounce(() => updateTitlePlaceholder(), 500);

function wireEditor() {
  editor.addEventListener('change', (e) => {
    if (e.detail.structural && editor.clearTranslationsForMode()) { /* dropped stale translations */ }
    sync.markDirty('orig');
    queue.schedule();
    updateStatus();
    updatePlaceholderSoon();
  });
  editor.addEventListener('trchange', (e) => {
    sync.markDirty('tr');
    if (e.detail.cleared) queue.schedule(0);
    updateStatus();
  });
  editor.addEventListener('flush', () => queue.flushNow());
  editor.addEventListener('slash', (e) => openTagMenu(e.detail.anchor, { query: e.detail.query, slash: true }));
  editor.addEventListener('slashclose', () => { if (S.slashMenu) closePopover(); });
  editor.addEventListener('slashkey', (e) => S.slashMenu?.key(e.detail.key));
  editor.addEventListener('pill', (e) => openPillMenu(e.detail));
  editor.addEventListener('status', (e) => openStatusMenu(e.detail));
  editor.addEventListener('selection', (e) => {
    const n = e.detail.count;
    $('#selbar').hidden = n === 0;
    $('#selbar-count').textContent = `${n} line${n === 1 ? '' : 's'}`;
  });
  editor.addEventListener('copylines', async (e) => {
    await copyText(e.detail.text);
    if (e.detail.cut) editor.deleteSelected();
    toast(e.detail.cut ? 'Lines cut' : 'Lines copied', { timeout: 1500 });
  });
  $('#tail-pad').addEventListener('click', () => editor.focusLine(editor.lines.length - 1, 'end'));
}

function wireQueue() {
  queue.addEventListener('translated', () => {
    sync.markDirty('tr');
    S.engineWarn = '';
    updateStatus();
  });
  queue.addEventListener('status', () => updateStatus());
  queue.addEventListener('detected', (e) => {
    if (S.detected !== e.detail.lang) {
      S.detected = e.detail.lang;
      updatePaneHead();
    }
  });
  queue.addEventListener('fallback', (e) => {
    S.engineWarn = 'using your browser';
    updateStatus();
    if (Date.now() - S.lastErrorToast > 30_000) {
      S.lastErrorToast = Date.now();
      toast(`Server engines are busy, so ${e.detail.count} line(s) were translated directly from your browser.`, { timeout: 5000 });
    }
  });
  queue.addEventListener('error', (e) => {
    S.engineWarn = e.detail.offline ? 'offline' : 'errors';
    updateStatus();
    refreshEnginesQuietly();
    if (Date.now() - S.lastErrorToast < 20_000) return;
    S.lastErrorToast = Date.now();
    toast(e.detail.offline ? 'Offline: translations will resume when the connection is back.' : `Translation problem: ${e.detail.message}`, {
      type: 'warn',
      timeout: 7000,
      action: e.detail.offline ? null : 'Retry',
      onAction: () => queue.flush({ retryErrors: true }),
    });
  });
  window.addEventListener('online', () => queue.flush({ retryErrors: true }));
}

function wireSync() {
  sync.addEventListener('state', (e) => setSaveState(e.detail.state, e.detail.message));
  sync.addEventListener('saved', (e) => {
    S.note.version = e.detail.version;
    const item = S.notes.find((x) => x.id === S.note.id);
    if (item) {
      item.updatedAt = e.detail.updatedAt;
      item.lineCount = e.detail.lineCount;
      if (item.title !== S.note.title) {
        item.title = S.note.title;
        renderNoteList();
      }
    }
  });
  sync.addEventListener('conflict', (e) => openConflictDialog(e.detail));
  sync.addEventListener('missing', () => openMissingDialog());
  $('#save-state').addEventListener('click', () => {
    if (sync.state === 'conflict') openConflictDialog({});
    else sync.save({ force: false });
  });
}

// ------------------------------------------------------------------ menus
function tagItemsHtml(t) {
  return `<span class="pill" style="--c:${esc(t.color)}">${esc(t.name)}</span>`;
}

function openTagMenu(anchor, { query = '', slash = false, onPick } = {}) {
  const tags = S.config.tags;
  let active = 0;
  let filtered = tags;
  const pick = (name) => {
    S.slashMenu = null;
    closePopover();
    if (onPick) return onPick(name);
    if (slash) editor.applySlash(name);
    else editor.insertTag(name);
  };
  const { pop } = openPopover(anchor, (popEl) => {
    popEl.setAttribute('role', 'listbox');
    if (!slash) popEl.innerHTML = '<input class="menu-filter" type="text" placeholder="Filter or create a tag…" aria-label="Filter tags">';
    popEl.insertAdjacentHTML('beforeend', '<div class="menu-title">Insert tag</div><div class="tag-items"></div>');
  }, { keepFocus: slash, onClose: () => { S.slashMenu = null; } });
  const list = pop.querySelector('.tag-items');
  const render = (q) => {
    const qq = q.trim().toUpperCase();
    filtered = tags.filter((t) => !qq || t.name.includes(qq));
    active = Math.min(active, Math.max(0, filtered.length - 1));
    list.innerHTML = filtered.map((t, k) => `<button type="button" class="menu-item${k === active ? ' active' : ''}" data-name="${esc(t.name)}">${tagItemsHtml(t)}<span><span class="mi-desc">${esc(t.description || (t.kind === 'line' ? 'Tags one line' : 'Block'))}</span></span>${!slash && k < 9 ? `<span class="mi-hint">Alt+${k + 1}</span>` : ''}</button>`).join('')
      + (qq && /^[A-Z][A-Z0-9_-]*$/.test(qq) && !filtered.length ? `<button type="button" class="menu-item" data-create="${esc(qq)}">${icon('plus')}<span>Create tag <b>${esc(qq)}</b></span></button>` : '')
      + (!filtered.length && !qq ? '<div class="menu-title">No tags</div>' : '');
  };
  render(query);
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.create) {
      const name = b.dataset.create;
      try {
        const r = await api.post('api/tags', { name, color: randomColor(name), kind: 'section' });
        S.config.tags = r.tags;
        editor.setTags(r.tags);
        toast(`Tag ${name} created — customise it in the admin dashboard`);
        pick(name);
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
      return;
    }
    pick(b.dataset.name);
  });
  const filter = pop.querySelector('.menu-filter');
  filter?.addEventListener('input', () => { active = 0; render(filter.value); });
  filter?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      S.slashMenu.key(e.key);
    }
  });
  S.slashMenu = {
    key(k) {
      if (k === 'Escape') { closePopover(); return; }
      if (k === 'ArrowDown') active = Math.min(active + 1, filtered.length - 1);
      if (k === 'ArrowUp') active = Math.max(active - 1, 0);
      if (k === 'Enter' || k === 'Tab') {
        const create = list.querySelector('[data-create]');
        if (!filtered.length && create) { create.click(); return; }
        if (filtered[active]) pick(filtered[active].name);
        return;
      }
      list.querySelectorAll('.menu-item').forEach((b, i) => b.classList.toggle('active', i === active));
      list.querySelectorAll('.menu-item')[active]?.scrollIntoView({ block: 'nearest' });
    },
    update(q) { render(q); },
  };
  if (slash) {
    editor.addEventListener('slash', function upd(ev) {
      if (!S.slashMenu) { editor.removeEventListener('slash', upd); return; }
      S.slashMenu.update(ev.detail.query);
    });
  }
}

function randomColor(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 45%)`.replace(/hsl\((\d+) (\d+)% (\d+)%\)/, (_, a, b, c) => hslToHex(+a, +b, +c));
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}

function openPillMenu({ index, k, anchor }) {
  const info = editor.info[index];
  const tok = info?.tokens[k];
  if (!tok) return;
  const def = editor.tagMap.get(tok.name);
  const items = [{ title: tok.closing ? `End of ${tok.name || 'block'}` : `${tok.name}${def ? ` · ${def.kind}` : ''}` }];
  if (def?.description) items.push({ label: def.description, disabled: true });
  if (!tok.closing) {
    items.push({
      label: 'Change tag…', icon: 'tag', onClick: () => openTagMenu(anchor, { onPick: (name) => editor.replaceToken(index, k, name) }),
    });
    if (info.role === 'open' && def?.kind !== 'line') items.push({ label: 'Add closing tag', icon: 'check', onClick: () => editor.closeBlockAt(index, tok.name) });
  }
  items.push({ label: 'Remove tag', icon: 'x', danger: true, onClick: () => editor.removeToken(index, k) });
  openMenu(anchor, items);
}

function openStatusMenu({ index, anchor }) {
  const line = editor.lines[index];
  const state = editor.trState(index);
  const items = [];
  if (state === 'error') items.push({ title: line._error || 'Translation failed' });
  if (line.trEngine) items.push({ title: `Engine: ${S.config.engines.find((e) => e.id === line.trEngine)?.name || line.trEngine}` });
  items.push({
    label: state === 'manual' || state === 'stale' ? 'Replace with machine translation' : 'Translate this line again',
    icon: 'refresh',
    onClick: () => {
      editor.resetTranslations([line.id]);
      queue.flush({ retryErrors: true });
    },
  });
  if (line.tr) items.push({ label: 'Copy translation', icon: 'copy', onClick: () => copyText(line.tr) });
  openMenu(anchor, items);
}

function openFontPopover() {
  openPopover($('#btn-font'), (pop) => {
    const p = prefs.all();
    pop.style.padding = '12px';
    pop.innerHTML = `
      <div class="field"><span>Text size</span><div class="range-row"><input type="range" min="12" max="28" step="1" value="${p.fontSize}" id="pf-size"><b id="pf-size-v">${p.fontSize}px</b></div></div>
      <div class="field"><span>Font</span><div class="seg" id="pf-font">${['sans', 'serif', 'mono'].map((f) => `<button type="button" data-v="${f}" aria-pressed="${p.font === f}">${f === 'sans' ? 'Sans' : f === 'serif' ? 'Serif' : 'Mono'}</button>`).join('')}</div></div>
      <div class="field"><span>Line spacing</span><div class="seg" id="pf-lh">${[[1.35, 'Compact'], [1.55, 'Normal'], [1.85, 'Relaxed']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${Number(p.lineHeight) === v}">${l}</button>`).join('')}</div></div>
      <div class="field"><span>Theme</span><div class="seg" id="pf-theme">${['auto', 'light', 'dark'].map((t) => `<button type="button" data-v="${t}" aria-pressed="${p.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>`;
    pop.querySelector('#pf-size').addEventListener('input', (e) => {
      prefs.set('fontSize', Number(e.target.value));
      pop.querySelector('#pf-size-v').textContent = `${e.target.value}px`;
      applyPrefs();
    });
    const seg = (id, key, conv = (v) => v) => pop.querySelector(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      prefs.set(key, conv(b.dataset.v));
      pop.querySelectorAll(`${id} button`).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      applyPrefs();
    });
    seg('#pf-font', 'font');
    seg('#pf-lh', 'lineHeight', Number);
    seg('#pf-theme', 'theme');
  }, { align: 'end' });
}

function openMoreMenu() {
  openMenu($('#btn-more'), [
    { label: 'Export / print…', icon: 'download', onClick: openExportDialog },
    { label: 'Import a file…', icon: 'upload', onClick: () => $('#file-input').click() },
    { label: S.bulk ? 'Leave plain-text mode' : 'Plain-text mode (edit all at once)', icon: 'text', onClick: () => setBulk(!S.bulk) },
    { label: 'Version history…', icon: 'history', onClick: openHistoryDialog },
    'sep',
    { label: 'Translate everything again', icon: 'refresh', desc: 'Re-requests all machine translations (manual edits are kept)', onClick: retranslateAll },
    { label: 'Copy original', icon: 'copy', onClick: () => copyAll('src') },
    { label: 'Copy translation', icon: 'copy', onClick: () => copyAll('tr') },
    'sep',
    { label: 'New note', icon: 'plus', hint: 'Alt+N', onClick: () => createNote() },
    { label: 'Duplicate note', icon: 'dup', onClick: () => duplicateNote(S.note.id) },
    { label: 'Move note to trash', icon: 'trash', danger: true, onClick: () => deleteNote(S.note.id) },
    'sep',
    { label: 'Line numbers', icon: 'hash', hint: prefs.get('lineNumbers') ? 'on' : 'off', onClick: () => toggle('lineNumbers') },
    { label: 'Alternating shades', icon: 'stripes', hint: prefs.get('zebra') ? 'on' : 'off', onClick: () => toggle('zebra') },
    { label: 'Syntax colors', icon: 'sparkle', hint: prefs.get('highlight') ? 'on' : 'off', onClick: () => toggle('highlight') },
    { label: 'Text size, font & theme…', icon: 'type', onClick: openFontPopover },
    { label: 'Help & keyboard shortcuts', icon: 'keyboard', hint: 'Ctrl+/', onClick: openHelpDialog },
    ...(S.config.adminEnabled ? [{ label: 'Admin dashboard', icon: 'external', onClick: () => window.open('admin', '_blank', 'noopener') }] : []),
  ], { align: 'end' });
}

function toggle(key) {
  prefs.set(key, !prefs.get(key));
  applyPrefs();
}

function retranslateAll() {
  const ids = editor.lines.filter((l) => !l.trManual).map((l) => l.id);
  editor.resetTranslations(ids);
  queue.flush({ retryErrors: true });
  toast('Translating all lines again…', { timeout: 2000 });
}

function lineTranslationText(i) {
  const info = editor.info[i];
  const p = editor.plans[i];
  if (info.role === 'open' || info.role === 'close' || info.role === 'marker') return editor.lines[i].text;
  if (p.mode === 'none') return '';
  return serializeLine(info.role === 'inline' ? info.tokens : [], p.mode === 'copy' ? info.body : editor.lines[i].tr || '');
}

async function copyAll(side) {
  const text = side === 'src' ? editor.texts().join('\n') : editor.lines.map((_, i) => lineTranslationText(i)).join('\n');
  await copyText(text);
  toast(side === 'src' ? 'Original copied' : 'Translation copied', { timeout: 1500 });
}

// ------------------------------------------------------------------ dialogs
function openExportDialog() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field"><span>Content</span><div class="seg" id="ex-side">
      <button type="button" data-v="both" aria-pressed="true">Both side by side</button><button type="button" data-v="original" aria-pressed="false">Original</button><button type="button" data-v="translation" aria-pressed="false">Translation</button></div></div>
    <div class="field"><span>Format</span><div class="seg" id="ex-format">
      <button type="button" data-v="html" aria-pressed="true">Print / HTML</button><button type="button" data-v="txt" aria-pressed="false">Text</button><button type="button" data-v="md" aria-pressed="false">Markdown</button><button type="button" data-v="csv" aria-pressed="false">CSV</button><button type="button" data-v="json" aria-pressed="false">JSON</button></div></div>
    <p class="muted" style="color:var(--muted);font-size:13px">"Print / HTML" opens a clean, line-numbered side-by-side page you can print or save as PDF. CSV opens in Excel / Sheets with one row per line.</p>`;
  const seg = (id) => body.querySelector(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    body.querySelectorAll(`${id} button`).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
  });
  seg('#ex-side');
  seg('#ex-format');
  const val = (id) => body.querySelector(`${id} [aria-pressed="true"]`).dataset.v;
  openModal({
    title: 'Export note',
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Export',
        primary: true,
        onClick: async () => {
          await sync.flush().catch(() => {});
          const format = val('#ex-format');
          const side = format === 'json' ? 'original' : val('#ex-side');
          const url = `api/notes/${S.note.id}/export?format=${format}&side=${side}`;
          if (format === 'html') window.open(`${url}&inline=1`, '_blank', 'noopener');
          else {
            const a = document.createElement('a');
            a.href = url;
            a.download = '';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        },
      },
    ],
  });
}

async function openHistoryDialog() {
  await sync.flush().catch(() => {});
  let revs = [];
  try {
    revs = (await api.get(`api/notes/${S.note.id}/revisions`)).revisions;
  } catch (e) {
    toast(e.message, { type: 'error' });
    return;
  }
  const body = document.createElement('div');
  body.innerHTML = `<p style="margin-top:0;color:var(--muted);font-size:13px">Snapshots are taken automatically while you work (and before large deletions). Restoring keeps a snapshot of the current version too.</p>
    <ul class="rev-list">${revs.map((r) => `<li data-id="${r.id}"><div class="rev-main"><div>${esc(new Date(r.createdAt).toLocaleString())}</div><div class="rev-sub">${esc(r.reason)} · ${r.lineCount} lines · v${r.version}</div></div>
    <button class="btn" data-preview>Preview</button><button class="btn primary" data-restore>Restore</button></li>`).join('') || '<li>No snapshots yet</li>'}</ul><div class="rev-preview" hidden></div>`;
  const m = openModal({ title: 'Version history', body, wide: true, buttons: [{ label: 'Close' }] });
  body.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('[data-preview]')) {
      const r = await api.get(`api/notes/${S.note.id}/revisions/${li.dataset.id}`);
      const pv = body.querySelector('.rev-preview');
      pv.hidden = false;
      pv.textContent = r.lines.slice(0, 200).map((l, i) => `${String(i + 1).padStart(3)}  ${l.text}`).join('\n') + (r.lines.length > 200 ? '\n…' : '');
    }
    if (e.target.closest('[data-restore]')) {
      const n = await api.post(`api/notes/${S.note.id}/revisions/${li.dataset.id}/restore`);
      m.close();
      await openNote(n.id, { note: n });
      toast('Version restored');
    }
  });
}

function openConflictDialog() {
  openModal({
    title: 'This note was changed somewhere else',
    body: '<p>Another tab or device saved a newer version of this note while you were editing. What should happen with your version?</p>',
    buttons: [
      {
        label: 'Load the other version',
        onClick: async () => {
          sync.clearBackup();
          sync.noteId = null;
          await openNote(S.note.id);
        },
      },
      {
        label: 'Save mine as a copy',
        onClick: async () => {
          const payload = getPayload();
          sync.clearBackup();
          const n = await api.post('api/notes', { ...payload, title: `${payload.title || 'Untitled'} (my version)` });
          sync.noteId = null;
          await refreshNoteList();
          await openNote(n.id, { note: n });
        },
      },
      { label: 'Overwrite with mine', primary: true, onClick: () => sync.save({ force: true }) },
    ],
  });
}

function openMissingDialog() {
  openModal({
    title: 'Note not found on the server',
    body: '<p>This note was deleted (or moved to the trash) from another tab or device.</p>',
    buttons: [
      {
        label: 'Save it as a new note',
        primary: true,
        onClick: async () => {
          const n = await api.post('api/notes', getPayload());
          sync.clearBackup();
          sync.noteId = null;
          await refreshNoteList();
          await openNote(n.id, { note: n });
        },
      },
    ],
  });
}

function openHelpDialog() {
  const tags = S.config.tags.map((t) => `<span class="pill" style="--c:${esc(t.color)}" title="${esc(t.description)}">${esc(t.name)}</span>`).join('');
  const k = (s) => s.split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('+');
  openModal({
    title: 'Help & shortcuts',
    wide: true,
    body: `<div class="help-grid">
      <div><h3>Lines & alignment</h3><p>Every line is a row. The translation of line 12 is always on row 12, however long either side gets. Only lines you add or change are translated.</p>
      <h3>Tags</h3><p>Type <code>/</code> on an empty line, press ${k('Ctrl+K')} or use the Tags button. A tag on its own line opens a block until <code>[/TAG]</code> or the next block; <code>[TAG] text</code> tags just that line.</p><div class="tag-legend">${tags}</div>
      <h3>Never translated</h3><p><code>\`backticks\`</code>, <code>{{variables}}</code>, blanks <code>____</code>, URLs, and anything inside <code>[NOTRANSLATE]</code>.</p>
      <h3>Markdown</h3><p><code># Heading</code>, <code>&gt; quote</code>, <code>- list</code>, <code>1. list</code> — the markers are kept, the text is translated.</p></div>
      <div><h3>Keyboard</h3><table class="kbd-table">
      <tr><td>${k('Enter')}</td><td>New line (splits the line)</td></tr>
      <tr><td>${k('Backspace')} at start</td><td>Join with the line above / remove a tag pill</td></tr>
      <tr><td>${k('Alt+↑')} ${k('Alt+↓')}</td><td>Move line up / down</td></tr>
      <tr><td>${k('Ctrl+Z')} ${k('Ctrl+Y')}</td><td>Undo / redo</td></tr>
      <tr><td>${k('Ctrl+Enter')}</td><td>Translate now</td></tr>
      <tr><td>${k('Ctrl+K')}</td><td>Insert tag</td></tr>
      <tr><td>${k('Alt+1')}…${k('Alt+9')}</td><td>Insert tag 1–9</td></tr>
      <tr><td>${k('Ctrl+A')} twice</td><td>Select all lines</td></tr>
      <tr><td>Click line number</td><td>Select lines (Shift / Ctrl to extend), then copy, cut, delete, wrap in a tag</td></tr>
      <tr><td>${k('Alt+T')}</td><td>Show / hide the translation pane</td></tr>
      <tr><td>${k('Alt+L')}</td><td>Switch layout</td></tr>
      <tr><td>${k('Alt+F')}</td><td>Fullscreen / focus mode</td></tr>
      <tr><td>${k('Alt+N')}</td><td>Notes list</td></tr>
      <tr><td>${k('Ctrl+S')}</td><td>Save now (it also saves automatically)</td></tr>
      </table></div></div>`,
  });
}

// ------------------------------------------------------------------ bulk mode
function setBulk(on) {
  const main = $('#main');
  const ta = $('#bulk-editor');
  if (on) {
    S.bulk = true;
    ta.value = editor.texts().join('\n');
    ta.hidden = false;
    $('#bulkbar').hidden = false;
    main.classList.add('bulk');
    ta.focus();
  } else {
    S.bulk = false;
    const texts = ta.value.replace(/\r\n?/g, '\n').split('\n');
    ta.hidden = true;
    $('#bulkbar').hidden = true;
    main.classList.remove('bulk');
    const changed = texts.length !== editor.lines.length || texts.some((t, i) => t !== editor.lines[i].text);
    if (changed) editor.replaceAllTexts(texts);
    queue.schedule(0);
    editor.focusLine(0, 0);
  }
}

// ------------------------------------------------------------------ toolbar & drawer wiring
function wireToolbar() {
  const saveTitle = debounce(() => setMeta({}), 400);
  $('#note-title').addEventListener('input', (e) => {
    S.note.title = e.target.value;
    saveTitle();
  });
  $('#note-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor.focusLine(0, 'end');
    }
  });
  $('#sel-source').addEventListener('change', (e) => onLangChange('source', e.target.value));
  $('#sel-target').addEventListener('change', (e) => onLangChange('target', e.target.value));
  $('#btn-swap').addEventListener('click', swapLanguages);
  $('#sel-engine').addEventListener('change', (e) => {
    S.note.engine = e.target.value;
    prefs.set('lastEngine', e.target.value);
    setMeta({});
    S.engineWarn = '';
    updateStatus();
    const translated = editor.lines.some((l) => l.tr && !l.trManual);
    queue.schedule(0);
    if (translated) toast('New and edited lines will use this engine.', { action: 'Translate all again', onAction: retranslateAll, timeout: 6000 });
  });
  $('#btn-tags').addEventListener('click', () => openTagMenu($('#btn-tags')));
  $('#tg-numbers').addEventListener('click', () => toggle('lineNumbers'));
  $('#tg-zebra').addEventListener('click', () => toggle('zebra'));
  $('#tg-highlight').addEventListener('click', () => toggle('highlight'));
  $('#tg-layout').addEventListener('click', cycleLayout);
  $('#tg-translation').addEventListener('click', () => toggleTranslationPane());
  $('#btn-hide-tr').addEventListener('click', () => toggleTranslationPane(false));
  $('#btn-font').addEventListener('click', openFontPopover);
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#btn-more').addEventListener('click', openMoreMenu);
  $('#btn-copy-src').addEventListener('click', () => copyAll('src'));
  $('#btn-copy-tr').addEventListener('click', () => copyAll('tr'));
  $('#btn-retranslate').addEventListener('click', () => {
    queue.flush({ retryErrors: true });
    toast('Translating missing lines…', { timeout: 1500 });
  });
  $('#btn-bulk-done').addEventListener('click', () => setBulk(false));
  $('#file-input').addEventListener('change', importFile);
}

async function importFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  try {
    let n;
    if (/\.json$/i.test(file.name)) n = await api.post('api/notes/import', JSON.parse(text));
    else {
      n = await api.post('api/notes/import', {
        title: file.name.replace(/\.[^.]+$/, ''), text, sourceLang: prefs.get('lastSource') || S.config.defaults.source, targetLang: prefs.get('lastTarget') || S.config.defaults.target,
      });
    }
    await refreshNoteList();
    await openNote(n.id, { note: n });
    toast(`Imported ${n.lines.length} lines`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, { type: 'error' });
  }
}

function setDrawer(open) {
  const d = $('#drawer');
  const wide = window.matchMedia('(min-width: 1100px)').matches;
  d.hidden = !open;
  d.classList.toggle('pinned', open && wide);
  $('#drawer-scrim').hidden = !open || wide;
  $('#btn-drawer').setAttribute('aria-expanded', open ? 'true' : 'false');
  prefs.set('drawerPinned', open && wide);
  if (open) {
    refreshNoteList();
    if (!wide) setTimeout(() => $('#note-search').focus(), 50);
  }
  requestAnimationFrame(applyLayout);
}

function wireDrawer() {
  $('#btn-drawer').addEventListener('click', () => setDrawer($('#drawer').hidden));
  $('#btn-drawer-close').addEventListener('click', () => setDrawer(false));
  $('#drawer-scrim').addEventListener('click', () => setDrawer(false));
  $('#btn-new-note').addEventListener('click', () => createNote());
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#note-search').addEventListener('input', debounce(() => refreshNoteList(), 250));
  $('#note-list').addEventListener('click', (e) => {
    const li = e.target.closest('.note-item');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('[data-menu]')) {
      const n = S.notes.find((x) => x.id === id);
      openMenu(e.target.closest('[data-menu]'), [
        { label: 'Open', icon: 'file', onClick: () => openNote(id) },
        { label: n?.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: () => togglePin(id) },
        { label: 'Duplicate', icon: 'dup', onClick: () => duplicateNote(id) },
        { label: 'Move to trash', icon: 'trash', danger: true, onClick: () => deleteNote(id) },
      ], { align: 'end' });
      return;
    }
    if (id !== S.note?.id) openNote(id);
    else if (!window.matchMedia('(min-width: 1100px)').matches) setDrawer(false);
  });
  $('#note-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('note-item')) openNote(e.target.dataset.id);
  });
  if (prefs.get('drawerPinned') && window.matchMedia('(min-width: 1100px)').matches) setDrawer(true);
}

function wireSelectionBar() {
  $('#selbar').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'copy' || act === 'copy-both') {
      await copyText(editor.selectedText(act === 'copy-both'));
      toast(act === 'copy' ? 'Lines copied' : 'Lines copied with translations (tab-separated)', { timeout: 1800 });
    } else if (act === 'cut') {
      await copyText(editor.selectedText());
      editor.deleteSelected();
    } else if (act === 'delete') editor.deleteSelected();
    else if (act === 'clear') editor.clearSelection();
    else if (act === 'retranslate') {
      const ids = editor.selectedIndexes().map((i) => editor.lines[i].id);
      editor.resetTranslations(ids);
      queue.flush({ retryErrors: true });
    } else if (act === 'wrap') openTagMenu(b, { onPick: (name) => editor.wrapSelection(name) });
  });
}

// ------------------------------------------------------------------ split, layout, viewport
function wireSplit() {
  const h = $('#split-handle');
  const setFromX = (x) => {
    const r = scroller.getBoundingClientRect();
    const gw = parseFloat(getComputedStyle(rowsEl).getPropertyValue('--gw')) || 40;
    const inner = r.width - 2 * gw - (scroller.offsetWidth - scroller.clientWidth);
    const s = (x - r.left - gw) / inner;
    const clamped = Math.max(0.2, Math.min(0.8, s));
    prefs.set('split', Math.round(clamped * 1000) / 1000);
    applySplit(clamped);
  };
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
    const move = (ev) => setFromX(ev.clientX);
    const up = () => {
      h.classList.remove('dragging');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
  h.addEventListener('dblclick', () => {
    prefs.set('split', 0.5);
    applySplit(0.5);
  });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const s = Math.max(0.2, Math.min(0.8, prefs.get('split') + (e.key === 'ArrowLeft' ? -0.02 : 0.02)));
    prefs.set('split', s);
    applySplit(s);
  });
  new ResizeObserver(() => applyLayout()).observe(scroller);
}

function wireViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return;
    app.style.height = `${vv.height}px`;
    app.style.top = `${vv.offsetTop}px`;
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
}

// ------------------------------------------------------------------ keyboard
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      sync.save({ force: false }).then(() => toast('Saved', { timeout: 1200 }));
      return;
    }
    if (mod && k === 'k') {
      e.preventDefault();
      openTagMenu($('#btn-tags'));
      return;
    }
    if (mod && (k === '/' || e.code === 'Slash')) {
      e.preventDefault();
      openHelpDialog();
      return;
    }
    if (e.altKey && !mod) {
      if (e.code === 'KeyT') { e.preventDefault(); toggleTranslationPane(); return; }
      if (e.code === 'KeyF') { e.preventDefault(); toggleFullscreen(); return; }
      if (e.code === 'KeyL') { e.preventDefault(); cycleLayout(); return; }
      if (e.code === 'KeyN') { e.preventDefault(); setDrawer($('#drawer').hidden); return; }
      const d = /^Digit([1-9])$/.exec(e.code);
      if (d && rowsEl.contains(document.activeElement)) {
        const tag = S.config.tags[Number(d[1]) - 1];
        if (tag) {
          e.preventDefault();
          editor.insertTag(tag.name);
        }
      }
    }
    if (e.key === 'Escape' && !isPopoverOpen() && !$('#drawer').hidden && !window.matchMedia('(min-width: 1100px)').matches) setDrawer(false);
  });
}

boot();
