// CleanTranslate admin dashboard.
import { api } from './api.js';
import { $, $$, esc, debounce, timeAgo, fmtNum, toast, openMenu, openModal, confirmDialog, copyText } from './ui.js';
import { icon, hydrateIcons, setIcon } from './icons.js';
import { prefs } from './prefs.js';
import { stackedColumns, meterHtml, compact } from './admin-charts.js';
import { LANGUAGES, languageName } from '../../shared/languages.js';

const content = $('#adm-content');
const TITLES = {
  overview: 'Overview', notes: 'Notes', engines: 'Translation engines', tags: 'Tags', cache: 'Translation cache',
  logs: 'Logs', api: 'API & embedding', settings: 'Settings', system: 'System & backup',
};
const CAT_LABEL = { free: 'Free', key: 'API key', selfhost: 'Self-hosted', custom: 'Custom', test: 'Test' };
let range = 30;
let system = null;
let current = null;

// ------------------------------------------------------------------ helpers
const h = (s) => esc(s);
const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const dur = (s) => (s > 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const baseUrl = () => new URL(document.baseURI).href.replace(/\/$/, '');

function badge(kind, ic, label, title = '') {
  return `<span class="badge ${kind}" title="${h(title)}">${icon(ic)}<span>${h(label)}</span></span>`;
}

function engineBadge(e) {
  const st = e.status || e;
  if (!e.enabled) return badge('off', 'x', 'Disabled');
  if (!st.configured) return badge('warning', 'alert', 'Needs setup', 'Fill in the required settings');
  if (st.coolingDown) return badge('warning', 'history', `Paused until ${new Date(st.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, st.lastError || '');
  if (st.lastErrorAt && st.lastErrorAt > (st.lastOkAt || 0)) return badge('critical', 'alert', 'Last call failed', st.lastError || '');
  if (st.lastOkAt) return badge('good', 'check', 'Working');
  return badge('good', 'check', 'Ready');
}

function langOptions(selected, allowAuto) {
  return (allowAuto ? `<option value="auto"${selected === 'auto' ? ' selected' : ''}>Detect language</option>` : '')
    + LANGUAGES.map((l) => `<option value="${l.code}"${l.code === selected ? ' selected' : ''}>${h(l.name)}</option>`).join('');
}

function setView(html) {
  content.innerHTML = html;
  hydrateIcons(content);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), { type: 'error' });
    return null;
  }
}

/** Stable color per engine: by first day it was ever used (new engines append, nobody gets repainted). */
function engineColorMap(usageAll, engineRows) {
  const first = new Map();
  for (const u of usageAll) {
    if (!(u.chars || u.requests)) continue;
    if (!first.has(u.engine) || u.day < first.get(u.engine)) first.set(u.engine, u.day);
  }
  // Ties (same first day) fall back to a fixed built-in rank, then creation time.
  const RANK = ['google-free', 'edge-free', 'lingva', 'mymemory', 'google-browser', 'libretranslate', 'deepl', 'google-cloud', 'azure'];
  const rank = (id) => (RANK.includes(id) ? RANK.indexOf(id) : RANK.length);
  const created = new Map(engineRows.map((e, i) => [e.id, e.createdAt ?? i]));
  const ordered = [...first.keys()].sort((a, b) => first.get(a).localeCompare(first.get(b)) || rank(a) - rank(b) || (created.get(a) ?? 0) - (created.get(b) ?? 0) || a.localeCompare(b));
  const map = new Map();
  ordered.forEach((id, i) => map.set(id, i < 7 ? `var(--series-${i + 1})` : null));
  return map;
}

function dayList(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10));
  return out;
}

// ------------------------------------------------------------------ overview
async function viewOverview() {
  const [ov, usageAll, eng] = await Promise.all([api.get('api/admin/overview'), api.get('api/admin/usage?days=400'), api.get('api/admin/engines')]);
  const names = new Map(eng.engines.map((e) => [e.id, e.name]));
  names.set('google-browser', names.get('google-browser') || 'Google (from your browser)');
  const days = dayList(range);
  const inRange = usageAll.usage.filter((u) => u.day >= days[0]);
  const sum = (k) => inRange.reduce((a, u) => a + (u[k] || 0), 0);
  const chars = sum('chars');
  const reqs = sum('requests');
  const hits = sum('cache_hits');
  const cachedChars = sum('cached_chars');
  const errors = sum('errors');
  const hitRate = chars + cachedChars ? Math.round((cachedChars / (chars + cachedChars)) * 100) : 0;
  const s = ov.stats;
  const chain = ov.autoChain.map((id) => names.get(id) || id);
  setView(`
    <section class="kpis" aria-label="Totals">
      <div class="tile"><div class="t-label">Notes</div><div class="t-value">${fmtNum(s.notes)}</div><div class="t-note">${fmtNum(s.trash)} in trash</div></div>
      <div class="tile"><div class="t-label">Lines</div><div class="t-value">${compact(s.lines)}</div><div class="t-note">${compact(s.chars)} characters</div></div>
      <div class="tile"><div class="t-label">Translated lines</div><div class="t-value">${compact(s.translated)}</div><div class="t-note">${s.lines ? Math.round((s.translated / s.lines) * 100) : 0}% of all lines</div></div>
      <div class="tile"><div class="t-label">Cached translations</div><div class="t-value">${compact(ov.cache.entries)}</div><div class="t-note">${compact(ov.cache.hits)} reuses so far</div></div>
      <div class="tile"><div class="t-label">Database</div><div class="t-value">${bytes(ov.dbBytes)}</div><div class="t-note">up ${dur(ov.uptimeSec)} · v${h(ov.version)}</div></div>
    </section>
    <div class="filters" role="group" aria-label="Period">
      <span class="muted small">Period</span>
      <div class="seg" id="ov-range">${[7, 30, 90].map((d) => `<button type="button" data-d="${d}" aria-pressed="${d === range}">Last ${d} days</button>`).join('')}</div>
    </div>
    <section class="kpis" aria-label="Translation activity in the period">
      <div class="tile"><div class="t-label">Characters sent to engines</div><div class="t-value">${compact(chars)}</div><div class="t-note">${fmtNum(reqs)} requests</div></div>
      <div class="tile"><div class="t-label">Served from cache</div><div class="t-value">${hitRate}%</div><div class="t-note">${fmtNum(hits)} lines, no engine call</div></div>
      <div class="tile"><div class="t-label">Engine errors</div><div class="t-value">${fmtNum(errors)}</div><div class="t-note"><a href="#/logs">see logs</a></div></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Characters sent to translation engines</h2><p class="sub">Per day, by engine. Lines served from the cache are not counted here.</p></div></div>
      <div id="ov-chart"></div>
    </section>
    <div class="grid2">
      <section class="card">
        <div class="card-head"><div><h2>Engines</h2><p class="sub">Auto chain: ${chain.length ? chain.map((c) => `<b>${h(c)}</b>`).join(' → ') : '<b>none enabled</b>'}</p></div><a class="btn" href="#/engines">Configure</a></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Engine</th><th>Status</th><th class="num">Today</th><th class="num">This month</th></tr></thead><tbody>
        ${eng.engines.filter((e) => e.enabled || e.usage.month.chars).map((e) => `<tr><td>${h(e.name)}${e.inAuto ? ' <span class="cat">auto</span>' : ''}</td><td>${engineBadge(e)}</td>
          <td class="num">${fmtNum(e.usage.today.chars)}</td><td class="num">${fmtNum(e.usage.month.chars)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Recent activity</h2></div><a class="btn" href="#/logs">All logs</a></div>
        <div class="tbl-wrap"><table class="tbl"><tbody>
        ${ov.recentLogs.map((l) => `<tr><td class="small muted" style="white-space:nowrap">${h(timeAgo(l.ts))}</td><td><span class="lvl ${h(l.level)}">${h(l.level)}</span></td><td class="clip" title="${h(l.message)}">${h(l.source)} — ${h(l.message)}</td></tr>`).join('') || '<tr><td class="empty">Nothing yet</td></tr>'}
        </tbody></table></div>
        <h3>Recently edited notes</h3>
        <div class="tbl-wrap"><table class="tbl"><tbody>
        ${ov.recentNotes.map((n) => `<tr><td><a href="./n/${h(n.id)}" target="_blank" rel="noopener">${h(n.title || n.preview.split(' · ')[0] || 'Untitled')}</a></td><td class="num muted">${n.lineCount} lines</td><td class="num muted">${h(timeAgo(n.updatedAt))}</td></tr>`).join('') || '<tr><td class="empty">No notes yet</td></tr>'}
        </tbody></table></div>
      </section>
    </div>`);
  // chart series: by entity color, tail folded into "Other"
  const colors = engineColorMap(usageAll.usage, eng.engines);
  const ids = [...new Set(inRange.filter((u) => u.chars).map((u) => u.engine))].sort((a, b) => [...colors.keys()].indexOf(a) - [...colors.keys()].indexOf(b));
  const byKey = new Map(inRange.map((u) => [`${u.day}|${u.engine}`, u.chars]));
  const series = [];
  const other = { id: '_other', name: 'Other', color: 'var(--series-other)', values: days.map(() => 0) };
  for (const id of ids) {
    const vals = days.map((d) => byKey.get(`${d}|${id}`) || 0);
    if (colors.get(id)) series.push({ id, name: names.get(id) || id, color: colors.get(id), values: vals });
    else vals.forEach((v, i) => { other.values[i] += v; });
  }
  if (other.values.some(Boolean)) series.push(other);
  stackedColumns($('#ov-chart'), { days, series, unit: 'characters', emptyText: 'No characters were sent to an engine in this period.' });
  $('#ov-range').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    range = Number(b.dataset.d);
    $('#ov-chart').style.opacity = '0.5';
    render();
  });
}

// ------------------------------------------------------------------ notes
let notesTrash = false;
async function viewNotes() {
  const q = $('#notes-q')?.value || '';
  const { notes } = await api.get(`api/admin/notes?trash=${notesTrash ? 1 : 0}&q=${encodeURIComponent(q)}`);
  setView(`
    <section class="card">
      <div class="card-head">
        <div><h2>${notesTrash ? 'Trash' : 'All notes'}</h2><p class="sub">${notesTrash ? 'Deleted notes stay here for the number of days set in Settings, then are purged.' : 'Every note autosaves. Open one in the editor, export it, browse its history or move it to the trash.'}</p></div>
        <div class="row-actions">
          <input class="inp" id="notes-q" type="search" placeholder="Search title and text…" value="${h(q)}" style="width:240px">
          <div class="seg"><button type="button" data-trash="0" aria-pressed="${!notesTrash}">Active</button><button type="button" data-trash="1" aria-pressed="${notesTrash}">Trash</button></div>
          ${notesTrash ? '<button class="btn danger" id="empty-trash" data-icon="trash"><span>Empty trash</span></button>' : '<a class="btn primary" href="./?new=1" target="_blank" data-icon="plus"><span>New note</span></a>'}
        </div>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Title</th><th>Languages</th><th class="num">Lines</th><th class="num">Translated</th><th class="num">${notesTrash ? 'Deleted' : 'Updated'}</th><th></th></tr></thead><tbody>
      ${notes.map((n) => `<tr data-id="${h(n.id)}">
        <td>${n.pinned ? icon('pin') : ''} ${notesTrash ? h(n.title || n.preview.split(' · ')[0] || 'Untitled') : `<a href="./n/${h(n.id)}" target="_blank" rel="noopener">${h(n.title || n.preview.split(' · ')[0] || 'Untitled')}</a>`}
          <div class="small muted clip">${h(n.preview)}</div></td>
        <td class="small">${h(languageName(n.sourceLang))} → ${h(languageName(n.targetLang))}</td>
        <td class="num">${fmtNum(n.lineCount)}</td><td class="num">${fmtNum(n.translatedCount)}</td>
        <td class="num small">${h(timeAgo(notesTrash ? n.deletedAt : n.updatedAt))}</td>
        <td><div class="row-actions" style="justify-content:flex-end">
          ${notesTrash ? '<button class="btn" data-act="restore">Restore</button><button class="btn danger" data-act="purge">Delete forever</button>'
            : '<button class="btn" data-act="export" data-icon="download"><span>Export</span></button><button class="btn" data-act="history" data-icon="history"><span>History</span></button><button class="icon-btn" data-act="trash" data-icon="trash" title="Move to trash"></button>'}
        </div></td></tr>`).join('') || `<tr><td colspan="6" class="empty">${notesTrash ? 'The trash is empty' : 'No notes found'}</td></tr>`}
      </tbody></table></div>
    </section>`);
  const qi = $('#notes-q');
  qi.addEventListener('input', debounce(() => render(), 300));
  if (q) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
  content.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-trash]');
    if (!b) return;
    notesTrash = b.dataset.trash === '1';
    render();
  });
  $('#empty-trash')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Empty the trash?', 'All notes in the trash and their history will be permanently deleted.', { ok: 'Delete forever', danger: true }))) return;
    await guarded(() => api.post('api/admin/trash/empty'));
    render();
  });
  content.querySelector('tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('tr').dataset.id;
    const act = b.dataset.act;
    if (act === 'trash') {
      await guarded(() => api.del(`api/notes/${id}`));
      toast('Moved to trash');
      render();
    } else if (act === 'restore') {
      await guarded(() => api.post(`api/admin/notes/${id}/restore`));
      render();
    } else if (act === 'purge') {
      if (!(await confirmDialog('Delete forever?', 'This note and its history will be gone for good.', { ok: 'Delete forever', danger: true }))) return;
      await guarded(() => api.del(`api/admin/notes/${id}`));
      render();
    } else if (act === 'export') {
      const link = (format, side, label, inline = false) => ({ label, onClick: () => window.open(`api/notes/${id}/export?format=${format}&side=${side}${inline ? '&inline=1' : ''}`, inline ? '_blank' : '_self') });
      openMenu(b, [
        link('html', 'both', 'Print view (side by side)', true),
        link('txt', 'original', 'Original — text'),
        link('txt', 'translation', 'Translation — text'),
        link('md', 'both', 'Both — Markdown table'),
        link('csv', 'both', 'Both — CSV (Excel)'),
        link('json', 'original', 'Full note — JSON'),
      ], { align: 'end' });
    } else if (act === 'history') {
      openHistory(id);
    }
  });
}

async function openHistory(id) {
  const { revisions } = await api.get(`api/notes/${id}/revisions`);
  const m = openModal({
    title: 'Version history',
    wide: true,
    body: `<ul class="rev-list">${revisions.map((r) => `<li data-rid="${r.id}"><div class="rev-main"><div>${h(new Date(r.createdAt).toLocaleString())}</div><div class="rev-sub">${h(r.reason)} · ${r.lineCount} lines · v${r.version}</div></div><button class="btn" data-p>Preview</button><button class="btn primary" data-r>Restore</button></li>`).join('') || '<li>No snapshots</li>'}</ul><div class="rev-preview" hidden></div>`,
  });
  m.body.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-rid]');
    if (!li) return;
    if (e.target.closest('[data-p]')) {
      const r = await api.get(`api/notes/${id}/revisions/${li.dataset.rid}`);
      const pv = m.body.querySelector('.rev-preview');
      pv.hidden = false;
      pv.textContent = r.lines.slice(0, 300).map((l, i) => `${String(i + 1).padStart(4)}  ${l.text}`).join('\n');
    } else if (e.target.closest('[data-r]')) {
      await guarded(() => api.post(`api/notes/${id}/revisions/${li.dataset.rid}/restore`));
      m.close();
      toast('Version restored');
      render();
    }
  });
}

// ------------------------------------------------------------------ engines
function fieldHtml(f, value, prefix = '') {
  const v = value ?? '';
  const id = `${prefix}${f.key}`;
  const req = f.required ? ' *' : '';
  let input;
  if (f.type === 'select') {
    input = `<select id="${h(id)}" data-key="${h(f.key)}"><option value="">(default)</option>${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${h(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${h(id)}" data-key="${h(f.key)}" rows="3" placeholder="${h(f.placeholder || '')}">${h(v)}</textarea>`;
  } else if (f.type === 'password') {
    input = `<div class="pw"><input id="${h(id)}" data-key="${h(f.key)}" type="password" value="${h(v)}" autocomplete="off" placeholder="${h(f.placeholder || '')}"><button type="button" class="btn" data-reveal>Show</button></div>`;
  } else {
    input = `<input id="${h(id)}" data-key="${h(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${h(v)}" placeholder="${h(f.placeholder || '')}">`;
  }
  return `<label class="fld"><span>${h(f.label)}${req}</span>${input}${f.help ? `<small>${h(f.help)}</small>` : ''}</label>`;
}

function readFields(root) {
  const out = {};
  root.querySelectorAll('[data-key]').forEach((i) => { out[i.dataset.key] = i.value; });
  return out;
}

function engineCard(e, i, total) {
  const m = e.meta;
  const lim = m.limits || {};
  const meters = [
    lim.perDay ? meterHtml(e.usage.today.chars, lim.perDay, 'today', icon) : '',
    lim.perMonth ? meterHtml(e.usage.month.chars, lim.perMonth, 'this month', icon) : '',
  ].join('');
  const st = e.status;
  const showErr = st.lastError && st.lastErrorAt > (st.lastOkAt || 0);
  return `<section class="card engine${e.enabled ? '' : ' disabled'}" data-id="${h(e.id)}">
    <div class="engine-head">
      <div class="engine-order"><button class="icon-btn" data-act="up" data-icon="arrowUp" title="Earlier in the auto chain" ${i === 0 ? 'disabled' : ''}></button><button class="icon-btn" data-act="down" data-icon="arrowDown" title="Later in the auto chain" ${i === total - 1 ? 'disabled' : ''}></button></div>
      <h2>${h(e.name)}</h2><span class="cat">${h(CAT_LABEL[m.category] || m.category)}</span>${engineBadge(e)}
      <span class="spacer"></span>
      ${m.serverSide ? `<label class="chk"><input type="checkbox" data-toggle="inAuto" ${e.inAuto ? 'checked' : ''}> In auto chain</label>` : ''}
      <label class="chk"><input type="checkbox" data-toggle="enabled" ${e.enabled ? 'checked' : ''}> Enabled</label>
    </div>
    <div class="small muted">${h(m.label)} — ${h(m.description)}</div>
    <div class="engine-meta"><span>Today <b>${fmtNum(e.usage.today.chars)}</b> chars · <b>${fmtNum(e.usage.today.requests)}</b> requests${e.usage.today.errors ? ` · <b>${fmtNum(e.usage.today.errors)}</b> errors` : ''}</span><span>This month <b>${fmtNum(e.usage.month.chars)}</b> chars</span>${st.lastLatency ? `<span>Last call <b>${st.lastLatency} ms</b></span>` : ''}</div>
    ${meters ? `<div class="row-actions" style="gap:24px">${meters}</div>` : ''}
    ${showErr ? `<div class="engine-err">${icon('alert')} ${h(st.lastError)} <span class="muted">(${h(timeAgo(st.lastErrorAt))})</span></div>` : ''}
    <div class="engine-notes"><b>Signup:</b> ${h(m.signup)} · <b>Limits:</b> ${h(lim.label || '—')}${m.docs ? ` · <a href="${h(m.docs)}" target="_blank" rel="noopener noreferrer">Documentation</a>` : ''}
      <ul>${m.notes.map((n) => `<li>${h(n)}</li>`).join('')}</ul></div>
    ${m.fields.length || m.serverSide ? `<details class="engine-cfg"${!st.configured && e.enabled ? ' open' : ''}><summary>Settings${m.serverSide ? ' & test' : ''}</summary>
      <div class="form-grid">
        <label class="fld"><span>Display name</span><input type="text" data-name value="${h(e.name)}"></label>
        ${m.fields.map((f) => fieldHtml(f, e.config[f.key], `${e.id}-`)).join('')}
      </div>
      <div class="row-actions">
        <button class="btn primary" data-act="save" data-icon="check"><span>Save</span></button>
        ${m.serverSide ? '<button class="btn" data-act="test" data-icon="zap"><span>Test</span></button>' : ''}
        ${st.coolingDown ? '<button class="btn" data-act="reset" data-icon="refresh"><span>Resume now</span></button>' : ''}
        ${e.builtin ? '' : '<button class="btn danger" data-act="delete" data-icon="trash"><span>Delete</span></button>'}
        <span class="test-result" data-result hidden></span>
      </div></details>` : ''}
  </section>`;
}

async function viewEngines() {
  const data = await api.get('api/admin/engines');
  const rows = data.engines;
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const typeOpts = Object.entries(CAT_LABEL).map(([cat, label]) => {
    const ts = data.types.filter((t) => t.category === cat);
    return ts.length ? `<optgroup label="${h(label)}">${ts.map((t) => `<option value="${h(t.type)}">${h(t.label)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  setView(`
    <section class="card">
      <h2>How translation works</h2>
      <p class="sub">The editor sends only new or changed lines. Each result is cached, so the same line is never paid for twice.
      With <b>Auto</b>, engines are tried top to bottom (only those marked "In auto chain"); when one is rate-limited or fails it is paused for a while and the next one answers.
      If every server engine is busy, the editor can translate straight from the visitor's browser (Settings → Browser fallback).</p>
      <div class="chain">${data.autoChain.length ? data.autoChain.map((id, k) => `${k ? '<span class="arrow">→</span>' : ''}<span class="badge">${h(names.get(id) || id)}</span>`).join('') : badge('warning', 'alert', 'No engine is in the auto chain')}</div>
    </section>
    <section class="card" id="add-engine">
      <div class="card-head"><div><h2>Add an engine</h2><p class="sub">Point CleanTranslate at another API — another LibreTranslate or Lingva server, DeepL, a custom JSON API, or a second CleanTranslate instance used as a middleman.</p></div></div>
      <div class="form-grid">
        <label class="fld"><span>Type</span><select id="new-type">${typeOpts}</select></label>
        <label class="fld"><span>Name</span><input type="text" id="new-name" placeholder="My engine"></label>
        <label class="fld" id="new-preset-wrap" hidden><span>Preset</span><select id="new-preset"></select></label>
      </div>
      <div id="new-desc" class="small muted"></div>
      <div class="form-grid" id="new-fields"></div>
      <div class="row-actions"><label class="chk"><input type="checkbox" id="new-auto"> Add to the auto chain</label><span class="spacer"></span><button class="btn primary" id="new-add" data-icon="plus"><span>Add engine</span></button></div>
    </section>
    ${rows.map((e, i) => engineCard(e, i, rows.length)).join('')}`);

  // add-engine form
  const typeSel = $('#new-type');
  const renderNew = (presetCfg = null) => {
    const t = data.types.find((x) => x.type === typeSel.value);
    $('#new-desc').textContent = `${t.description} Signup: ${t.signup}. Limits: ${t.limits?.label || '—'}.`;
    $('#new-fields').innerHTML = t.fields.map((f) => fieldHtml(f, presetCfg?.[f.key] ?? '', 'new-')).join('');
    const pw = $('#new-preset-wrap');
    pw.hidden = !t.presets;
    if (t.presets && !presetCfg) $('#new-preset').innerHTML = `<option value="">Choose a preset…</option>${t.presets.map((p) => `<option value="${h(p.id)}">${h(p.label)}</option>`).join('')}`;
    if (!$('#new-name').value || $('#new-name').dataset.auto) {
      $('#new-name').value = t.label.replace(/\s*\(.*\)$/, '');
      $('#new-name').dataset.auto = '1';
    }
  };
  typeSel.value = 'libretranslate';
  renderNew();
  typeSel.addEventListener('change', () => { $('#new-name').dataset.auto = '1'; renderNew(); });
  $('#new-name').addEventListener('input', () => { delete $('#new-name').dataset.auto; });
  $('#new-preset').addEventListener('change', (e) => {
    const t = data.types.find((x) => x.type === typeSel.value);
    const p = t.presets?.find((x) => x.id === e.target.value);
    if (p) {
      renderNew(p.config);
      if ($('#new-name').dataset.auto) $('#new-name').value = p.label.replace(/\s*\(.*\)$/, '');
    }
  });
  $('#new-add').addEventListener('click', async () => {
    const r = await guarded(() => api.post('api/admin/engines', { type: typeSel.value, name: $('#new-name').value, inAuto: $('#new-auto').checked, config: readFields($('#new-fields')) }));
    if (r) {
      toast(`Engine "${r.name}" added`);
      render();
    }
  });

  // engine cards
  content.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    const id = t.closest('.engine').dataset.id;
    await guarded(() => api.put(`api/admin/engines/${id}`, { [t.dataset.toggle]: t.checked }));
    render();
  }, { signal: viewSignal() });
  content.addEventListener('click', async (e) => {
    const rev = e.target.closest('[data-reveal]');
    if (rev) {
      const inp = rev.previousElementSibling;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      rev.textContent = inp.type === 'password' ? 'Show' : 'Hide';
      return;
    }
    const b = e.target.closest('.engine [data-act]');
    if (!b) return;
    const card = b.closest('.engine');
    const id = card.dataset.id;
    const act = b.dataset.act;
    if (act === 'up' || act === 'down') {
      const ids = rows.map((r) => r.id);
      const k = ids.indexOf(id);
      const j = act === 'up' ? k - 1 : k + 1;
      [ids[k], ids[j]] = [ids[j], ids[k]];
      await guarded(() => api.post('api/admin/engines/order', { ids }));
      render();
    } else if (act === 'save') {
      const cfg = readFields(card.querySelector('.engine-cfg'));
      const r = await guarded(() => api.put(`api/admin/engines/${id}`, { name: card.querySelector('[data-name]').value, config: cfg }));
      if (r) {
        toast('Saved');
        render();
      }
    } else if (act === 'test') {
      const out = card.querySelector('[data-result]');
      out.hidden = false;
      out.textContent = 'Testing…';
      const r = await guarded(() => api.post(`api/admin/engines/${id}/test`, { text: 'Hello, world! How are you today?', source: 'en', target: 'es' }));
      if (!r) { out.textContent = 'Test failed'; return; }
      out.innerHTML = r.ok ? `${icon('check')} <b>${h(r.text)}</b> <span class="muted">(${r.ms} ms)</span>` : `${icon('alert')} ${h(r.error)}`;
    } else if (act === 'reset') {
      await guarded(() => api.post(`api/admin/engines/${id}/reset`));
      render();
    } else if (act === 'delete') {
      if (!(await confirmDialog('Delete engine?', 'Its cached translations stay available.', { ok: 'Delete', danger: true }))) return;
      await guarded(() => api.del(`api/admin/engines/${id}`));
      render();
    }
  }, { signal: viewSignal() });
}

// ------------------------------------------------------------------ tags
async function viewTags() {
  const { settings, tagSuggestions, defaultTags } = await api.get('api/admin/settings');
  let tags = settings.tags.map((t) => ({ ...t }));
  const styles = ['none', 'dialog', 'grammar', 'vocab', 'table', 'story', 'exercise', 'note'];
  const draw = () => {
    setView(`
      <section class="card">
        <div class="card-head"><div><h2>Tags</h2><p class="sub">Tags appear as pills in the editor. Type <code>/</code> on an empty line (or Ctrl+K) to insert one.
          <b>Section</b> tags open a block that lasts until <code>[/TAG]</code> or the next section. <b>Span</b> tags (like NOTRANSLATE) work inside sections. <b>Line</b> tags only mark the line they are on.
          Turning off <b>Translate</b> means lines with that tag are copied as they are.</p></div>
          <div class="row-actions"><button class="btn" id="tags-reset">Reset to defaults</button><button class="btn primary" id="tags-save" data-icon="check"><span>Save tags</span></button></div></div>
        <div class="tag-row tag-head"><span>Color</span><span>Name</span><span>Kind</span><span>Style</span><span>Translate</span><span>Description</span><span></span></div>
        <div id="tag-rows">${tags.map((t, i) => `<div class="tag-row" data-i="${i}">
          <input type="color" data-f="color" value="${h(/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#64748b')}" aria-label="Color">
          <div style="display:flex;gap:8px;align-items:center;min-width:0"><input class="inp" data-f="name" value="${h(t.name)}" aria-label="Name"><span class="pill" style="--c:${h(t.color)};flex:none">${h(t.name || '?')}</span></div>
          <select class="inp" data-f="kind" aria-label="Kind">${['section', 'span', 'line'].map((k) => `<option${k === t.kind ? ' selected' : ''}>${k}</option>`).join('')}</select>
          <select class="inp" data-f="style" aria-label="Style">${styles.map((k) => `<option${k === t.style ? ' selected' : ''}>${k}</option>`).join('')}</select>
          <label class="chk"><input type="checkbox" data-f="translate" ${t.translate !== false ? 'checked' : ''}> yes</label>
          <input class="inp" data-f="description" value="${h(t.description || '')}" aria-label="Description">
          <button class="icon-btn" data-del data-icon="trash" title="Remove tag"></button></div>`).join('')}</div>
        <div class="row-actions" style="margin-top:12px"><button class="btn" id="tag-add" data-icon="plus"><span>Add a tag</span></button>
          <span class="muted small">Quick add:</span><div class="chips">${tagSuggestions.filter((s) => !tags.some((t) => t.name === s.name)).map((s) => `<button class="chip-btn" data-sugg="${h(s.name)}">+ ${h(s.name)}</button>`).join('')}</div></div>
      </section>`);
  };
  const sync = () => {
    $$('#tag-rows .tag-row').forEach((row) => {
      const t = tags[Number(row.dataset.i)];
      row.querySelectorAll('[data-f]').forEach((inp) => {
        t[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.dataset.f === 'name' ? inp.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') : inp.value;
      });
    });
  };
  draw();
  const ctl = viewSignal();
  content.addEventListener('input', (e) => {
    const row = e.target.closest('.tag-row[data-i]');
    if (!row) return;
    sync();
    const t = tags[Number(row.dataset.i)];
    const pill = row.querySelector('.pill');
    pill.textContent = t.name || '?';
    pill.style.setProperty('--c', t.color);
  }, { signal: ctl });
  content.addEventListener('click', async (e) => {
    if (e.target.closest('[data-del]')) {
      sync();
      tags.splice(Number(e.target.closest('.tag-row').dataset.i), 1);
      draw();
    } else if (e.target.closest('#tag-add')) {
      sync();
      tags.push({ name: 'NEWTAG', color: '#3b82f6', kind: 'section', style: 'none', translate: true, description: '' });
      draw();
      $$('#tag-rows .tag-row').at(-1)?.querySelector('[data-f="name"]').select();
    } else if (e.target.closest('[data-sugg]')) {
      sync();
      tags.push({ ...tagSuggestions.find((s) => s.name === e.target.closest('[data-sugg]').dataset.sugg) });
      draw();
    } else if (e.target.closest('#tags-reset')) {
      if (!(await confirmDialog('Reset tags?', 'The tag list goes back to the built-in tags. Text in your notes is not changed.', { ok: 'Reset' }))) return;
      tags = defaultTags.map((t) => ({ ...t }));
      draw();
    } else if (e.target.closest('#tags-save')) {
      sync();
      const bad = tags.find((t) => !/^[A-Z][A-Z0-9_-]*$/.test(t.name));
      if (bad) { toast(`Invalid tag name "${bad.name}" — use capital letters, digits, _ or -, starting with a letter`, { type: 'error' }); return; }
      const r = await guarded(() => api.put('api/admin/settings', { tags }));
      if (r) toast(`Saved ${r.settings.tags.length} tags — open editors pick them up on reload`);
    }
  }, { signal: ctl });
}

// ------------------------------------------------------------------ cache
async function viewCache() {
  const q = $('#cache-q')?.value || '';
  const engine = $('#cache-engine')?.value || '';
  const data = await api.get(`api/admin/cache?q=${encodeURIComponent(q)}&engine=${encodeURIComponent(engine)}&limit=200`);
  const st = data.stats;
  setView(`
    <section class="kpis">
      <div class="tile"><div class="t-label">Cached translations</div><div class="t-value">${fmtNum(st.entries)}</div></div>
      <div class="tile"><div class="t-label">Source characters cached</div><div class="t-value">${compact(st.chars)}</div></div>
      <div class="tile"><div class="t-label">Times reused</div><div class="t-value">${compact(st.hits)}</div></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Cache</h2><p class="sub">Every translation is stored by engine, language pair and exact text. Repeated lines, reopened notes and other users get them instantly without calling an engine. Least recently used entries are pruned past the limit set in Settings.</p></div>
        <div class="row-actions">
          <input class="inp" id="cache-q" type="search" placeholder="Search source or translation…" value="${h(q)}" style="width:240px">
          <select class="inp" id="cache-engine" style="width:auto"><option value="">All engines</option>${st.byEngine.map((b) => `<option value="${h(b.engine)}"${b.engine === engine ? ' selected' : ''}>${h(b.engine)} (${fmtNum(b.n)})</option>`).join('')}</select>
          <button class="btn danger" id="cache-clear" data-icon="trash"><span>${engine ? 'Clear this engine' : 'Clear all'}</span></button>
        </div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th>Translation</th><th>Engine</th><th>Pair</th><th class="num">Reused</th><th class="num">Last used</th><th></th></tr></thead><tbody>
      ${data.entries.map((c) => `<tr data-key="${h(c.key)}"><td class="clip" title="${h(c.src)}">${h(c.src)}</td><td class="clip" title="${h(c.out)}">${h(c.out)}</td><td class="small">${h(c.engine)}</td><td class="small">${h(c.sl)}→${h(c.tl)}</td><td class="num">${fmtNum(c.hits)}</td><td class="num small">${h(timeAgo(c.last_hit))}</td><td><button class="icon-btn" data-del data-icon="x" title="Delete entry"></button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nothing cached yet</td></tr>'}
      </tbody></table></div>
    </section>`);
  const ctl = viewSignal();
  const qi = $('#cache-q');
  qi.addEventListener('input', debounce(() => render(), 300), { signal: ctl });
  if (q) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
  $('#cache-engine').addEventListener('change', () => render(), { signal: ctl });
  $('#cache-clear').addEventListener('click', async () => {
    if (!(await confirmDialog('Clear the cache?', engine ? `All cached translations from "${engine}" will be deleted.` : 'All cached translations will be deleted. Notes keep their translations.', { ok: 'Clear', danger: true }))) return;
    const r = await guarded(() => api.del(`api/admin/cache${engine ? `?engine=${encodeURIComponent(engine)}` : ''}`));
    if (r) toast(`${fmtNum(r.deleted)} entries deleted`);
    render();
  }, { signal: ctl });
  content.querySelector('tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const tr = b.closest('tr');
    await guarded(() => api.del(`api/admin/cache/${encodeURIComponent(tr.dataset.key)}`));
    tr.remove();
  });
}

// ------------------------------------------------------------------ logs
let logLevel = '';
async function viewLogs() {
  const { logs } = await api.get(`api/admin/logs?level=${logLevel}&limit=300`);
  setView(`
    <section class="card">
      <div class="card-head"><div><h2>Logs</h2><p class="sub">Engine failures, rate limits and cool-downs, admin changes and maintenance. The newest 5,000 entries are kept.</p></div>
        <div class="row-actions"><div class="seg" id="lv">${[['', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === logLevel}">${l}</button>`).join('')}</div>
        <button class="btn danger" id="logs-clear" data-icon="trash"><span>Clear</span></button></div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead><tbody>
      ${logs.map((l) => `<tr><td class="small" style="white-space:nowrap" title="${h(new Date(l.ts).toISOString())}">${h(new Date(l.ts).toLocaleString())}</td><td><span class="lvl ${h(l.level)}">${h(l.level)}</span></td><td class="small mono">${h(l.source)}</td><td>${h(l.message)}${l.data ? ` <span class="small muted mono">${h(JSON.stringify(l.data))}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No log entries</td></tr>'}
      </tbody></table></div>
    </section>`);
  $('#lv').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    logLevel = b.dataset.v;
    render();
  });
  $('#logs-clear').addEventListener('click', async () => {
    if (!(await confirmDialog('Clear all logs?', 'This cannot be undone.', { ok: 'Clear', danger: true }))) return;
    await guarded(() => api.del('api/admin/logs'));
    render();
  });
}

// ------------------------------------------------------------------ API & embedding
async function viewApi() {
  const [{ settings }, eng] = await Promise.all([api.get('api/admin/settings'), api.get('api/admin/engines')]);
  const base = baseUrl();
  const keyHdr = settings.apiKey ? ` \\\n  -H "Authorization: Bearer ${settings.apiKey}"` : '';
  const engineIds = eng.engines.filter((e) => e.enabled && e.meta.serverSide).map((e) => e.id);
  setView(`
    <section class="card">
      <h2>Translation middleman API</h2>
      <p class="sub">Other apps, scripts, dashboards — or another CleanTranslate instance — can use this server as a translation service. Requests go through the same cache, fallback chain and engine settings as the editor.</p>
      <div class="form-grid">
        <label class="fld"><span>Public API</span><label class="chk"><input type="checkbox" id="api-enabled" ${settings.apiEnabled ? 'checked' : ''}> Enabled (/api/v1 and /api/libre)</label></label>
        <label class="fld"><span>API key (optional)</span><div class="pw"><input type="text" id="api-key" value="${h(settings.apiKey)}" placeholder="No key: open to anyone who can reach the server"><button type="button" class="btn" id="api-gen">Generate</button></div><small>Clients send <code>Authorization: Bearer &lt;key&gt;</code>, <code>X-API-Key</code> or <code>api_key</code>.</small></label>
        <label class="fld"><span>Allowed browser origins (CORS)</span><input type="text" id="api-cors" value="${h(settings.apiCors)}" placeholder="* or https://dash.example.com, https://other.example"><small>Use * to allow any site, or list origins separated by commas.</small></label>
        <label class="fld"><span>Rate limit per IP (requests / minute)</span><input type="number" id="api-rate" value="${h(settings.apiRateLimit)}" min="0"><small>0 disables the limit. Protects your engines from being burned by one client.</small></label>
      </div>
      <div class="row-actions"><button class="btn primary" id="api-save" data-icon="check"><span>Save API settings</span></button></div>
      <h3>Translate</h3>
      <pre class="code">curl -X POST ${h(base)}/api/v1/translate \\
  -H "Content-Type: application/json"${h(keyHdr)} \\
  -d '{"q": ["Hello world", "How are you?"], "source": "auto", "target": "es", "engine": "auto"}'</pre>
      <p class="small muted">Answer: <code>{"translations":[{"text":"Hola mundo","detectedSourceLanguage":"en","engine":"google-free","cached":false}, …], "detectedSourceLanguage":"en"}</code>. A single string <code>q</code> also returns <code>translatedText</code>. Optional: <code>"markup": true</code> keeps <code>\`backticks\`</code>, <code>{{vars}}</code>, blanks and URLs untranslated. Engine ids: <code>auto</code>${engineIds.map((i) => `, <code>${h(i)}</code>`).join('')}.</p>
      <pre class="code">curl "${h(base)}/api/v1/translate?q=Good%20morning&amp;target=de${settings.apiKey ? `&amp;key=${h(settings.apiKey)}` : ''}"</pre>
      <h3>LibreTranslate-compatible</h3>
      <p class="small muted">Tools and browser extensions that support LibreTranslate can use <code>${h(base)}/api/libre</code> as their server URL (<code>POST /translate</code>, <code>GET /languages</code>, <code>POST /detect</code>).</p>
      <h3>Other endpoints</h3>
      <p class="small muted"><code>GET /api/v1/engines</code> · <code>GET /api/v1/languages</code> · <code>GET /api/health</code> (for uptime monitors).</p>
    </section>
    <section class="card">
      <h2>Try it</h2>
      <div class="form-grid">
        <label class="fld"><span>Text (one line per entry)</span><textarea id="try-q" rows="3">Hello world. How are you?
The \`cat\` is on the table.</textarea></label>
        <div><label class="fld"><span>Target language</span><select id="try-tl">${langOptions('es', false)}</select></label>
        <label class="fld"><span>Engine</span><select id="try-eng"><option value="auto">auto</option>${engineIds.map((i) => `<option>${h(i)}</option>`).join('')}</select></label></div>
      </div>
      <div class="row-actions"><label class="chk"><input type="checkbox" id="try-markup" checked> markup</label><button class="btn primary" id="try-go" data-icon="zap"><span>Send request</span></button></div>
      <pre class="code" id="try-out" hidden></pre>
    </section>
    <section class="card">
      <h2>Embed the editor in another dashboard</h2>
      <p class="sub">Use an iframe. <code>?embed=1</code> hides the notes list and the admin link; add <code>&amp;note=ID</code> to open a specific note.</p>
      <pre class="code">&lt;iframe src="${h(base)}/?embed=1" style="width:100%;height:80vh;border:0" allow="clipboard-write; fullscreen"&gt;&lt;/iframe&gt;</pre>
      <label class="fld"><span>Sites allowed to embed this app (CSP frame-ancestors)</span><input type="text" id="api-fa" value="${h(settings.frameAncestors)}" ${system?.frameAncestorsFromEnv ? 'disabled' : ''}><small>${system?.frameAncestorsFromEnv ? 'Set by the FRAME_ANCESTORS environment variable.' : "* = anyone; 'self' = only this site; or list origins, e.g. 'self' https://dash.example.com"}</small></label>
      <div class="row-actions"><button class="btn primary" id="fa-save" data-icon="check"><span>Save</span></button></div>
      <p class="sub" style="margin-top:12px">To run it under a path of an existing site instead (e.g. <code>https://example.com/translate/</code>), set <code>BASE_PATH=/translate</code> and proxy that path to this server — see the README for nginx / Caddy snippets.</p>
    </section>`);
  $('#api-gen').addEventListener('click', () => {
    const a = new Uint8Array(20);
    crypto.getRandomValues(a);
    $('#api-key').value = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  });
  $('#api-save').addEventListener('click', async () => {
    const r = await guarded(() => api.put('api/admin/settings', { apiEnabled: $('#api-enabled').checked, apiKey: $('#api-key').value, apiCors: $('#api-cors').value, apiRateLimit: $('#api-rate').value }));
    if (r) { toast('API settings saved'); render(); }
  });
  $('#fa-save').addEventListener('click', async () => {
    const r = await guarded(() => api.put('api/admin/settings', { frameAncestors: $('#api-fa').value }));
    if (r) toast('Saved');
  });
  $('#try-go').addEventListener('click', async () => {
    const out = $('#try-out');
    out.hidden = false;
    out.textContent = 'Sending…';
    const headers = { 'Content-Type': 'application/json' };
    const key = $('#api-key').value.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    const t0 = performance.now();
    try {
      const res = await fetch('api/v1/translate', { method: 'POST', headers, body: JSON.stringify({ q: $('#try-q').value.split('\n').filter((l) => l.trim()), target: $('#try-tl').value, engine: $('#try-eng').value, markup: $('#try-markup').checked }) });
      const j = await res.json();
      out.textContent = `HTTP ${res.status} · ${Math.round(performance.now() - t0)} ms\n${JSON.stringify(j, null, 2)}`;
    } catch (e) {
      out.textContent = e.message;
    }
  });
}

// ------------------------------------------------------------------ settings
async function viewSettings() {
  const [{ settings: s }, cfg] = await Promise.all([api.get('api/admin/settings'), api.get('api/config')]);
  const ui = s.ui;
  const chk = (id, on, label) => `<label class="chk"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
  setView(`
    <section class="card">
      <h2>General</h2>
      <div class="form-grid">
        <label class="fld"><span>Name shown in the browser tab</span><input type="text" id="s-name" value="${h(s.instanceName)}"></label>
        <label class="fld"><span>Default source language (new notes)</span><select id="s-src">${langOptions(s.defaultSource, true)}</select></label>
        <label class="fld"><span>Default target language (new notes)</span><select id="s-tgt">${langOptions(s.defaultTarget, false)}</select></label>
        <label class="fld"><span>Default engine (new notes)</span><select id="s-eng"><option value="auto">Auto (fallback chain)</option>${cfg.engines.map((e) => `<option value="${h(e.id)}"${e.id === s.defaultEngine ? ' selected' : ''}>${h(e.name)}</option>`).join('')}</select></label>
      </div>
    </section>
    <section class="card">
      <h2>Saving & history</h2>
      <div class="form-grid">
        <label class="fld"><span>Autosave delay after typing (ms)</span><input type="number" id="s-autosave" value="${s.autosaveDelayMs}" min="200" max="10000"></label>
        <label class="fld"><span>Translate delay after typing (ms)</span><input type="number" id="s-trdelay" value="${s.translateDelayMs}" min="100" max="10000"><small>How long the editor waits after you stop typing before translating the line.</small></label>
        <label class="fld"><span>Snapshot interval (minutes)</span><input type="number" id="s-revint" value="${s.revisionIntervalMin}" min="1" max="1440"><small>A version snapshot is kept at most this often while a note changes (and always before large deletions).</small></label>
        <label class="fld"><span>Snapshots kept per note</span><input type="number" id="s-revkeep" value="${s.revisionKeep}" min="1" max="1000"></label>
        <label class="fld"><span>Days in trash before purge</span><input type="number" id="s-trash" value="${s.trashDays}" min="1" max="3650"></label>
      </div>
    </section>
    <section class="card">
      <h2>Translation</h2>
      <div class="form-grid">
        <label class="fld"><span>Cache</span>${chk('s-cache', s.cacheEnabled, 'Cache every translation (recommended)')}</label>
        <label class="fld"><span>Max cached translations</span><input type="number" id="s-cachemax" value="${s.cacheMaxEntries}" min="1000"></label>
        <label class="fld"><span>Cool-down after a rate limit (seconds)</span><input type="number" id="s-cool" value="${s.cooldownSec}" min="10" max="3600"><small>Doubles on repeated blocks (max 1 hour). Quota errors pause until midnight UTC.</small></label>
        <label class="fld"><span>Browser fallback</span>${chk('s-bfb', s.browserFallback, 'When server engines fail, translate from the visitor\'s browser (Google)')}</label>
      </div>
    </section>
    <section class="card">
      <h2>Editor defaults</h2>
      <p class="sub">Used on devices that have not changed these options themselves (each device remembers its own view settings).</p>
      <div class="form-grid">
        <div class="fld"><span>Show</span>${chk('u-num', ui.lineNumbers, 'Line numbers')}${chk('u-zebra', ui.zebra, 'Alternating shades')}${chk('u-hl', ui.highlight, 'Syntax colors')}${chk('u-tr', ui.showTranslation, 'Translation pane')}</div>
        <label class="fld"><span>Layout</span><select id="u-layout">${[['auto', 'Automatic (stacked on phones)'], ['side', 'Side by side'], ['stacked', 'Stacked']].map(([v, l]) => `<option value="${v}"${ui.layout === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="fld"><span>Text size (px)</span><input type="number" id="u-fs" value="${ui.fontSize}" min="10" max="32"></label>
        <label class="fld"><span>Theme</span><select id="u-theme">${['auto', 'light', 'dark'].map((v) => `<option${ui.theme === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
    </section>
    <div class="row-actions"><button class="btn primary" id="s-save" data-icon="check"><span>Save settings</span></button></div>`);
  $('#s-save').addEventListener('click', async () => {
    const v = (id) => $(id).value;
    const c = (id) => $(id).checked;
    const r = await guarded(() => api.put('api/admin/settings', {
      instanceName: v('#s-name'), defaultSource: v('#s-src'), defaultTarget: v('#s-tgt'), defaultEngine: v('#s-eng'),
      autosaveDelayMs: v('#s-autosave'), translateDelayMs: v('#s-trdelay'), revisionIntervalMin: v('#s-revint'), revisionKeep: v('#s-revkeep'),
      trashDays: v('#s-trash'), cacheEnabled: c('#s-cache'), cacheMaxEntries: v('#s-cachemax'), cooldownSec: v('#s-cool'), browserFallback: c('#s-bfb'),
      ui: { lineNumbers: c('#u-num'), zebra: c('#u-zebra'), highlight: c('#u-hl'), showTranslation: c('#u-tr'), layout: v('#u-layout'), fontSize: v('#u-fs'), theme: v('#u-theme') },
    }));
    if (r) {
      toast('Settings saved');
      $('#adm-name').textContent = r.settings.instanceName;
    }
  });
}

// ------------------------------------------------------------------ system
async function viewSystem() {
  system = await api.get('api/admin/system');
  const s = system;
  const row = (k, v) => `<tr><td class="muted" style="width:220px">${h(k)}</td><td class="mono">${h(v)}</td></tr>`;
  setView(`
    <div class="grid2">
      <section class="card"><h2>Server</h2><div class="tbl-wrap"><table class="tbl"><tbody>
        ${row('Version', s.version)}${row('Node.js', s.node)}${row('Platform', s.platform)}${row('Uptime', dur(s.uptimeSec))}${row('Memory', `${s.memoryMb} MB`)}
        ${row('Port', s.port)}${row('Base path', s.basePath)}${row('Data directory', s.dataDir)}${row('Database', `${s.dbFile} (${bytes(s.dbBytes)})`)}
        ${row('Engines configured', `${s.configuredEngines} of ${s.engineTypes} types available`)}
      </tbody></table></div></section>
      <section class="card"><h2>Security</h2>
        <div class="tbl-wrap"><table class="tbl"><tbody>
          <tr><td class="muted" style="width:220px">Whole app password</td><td>${s.basicAuth ? badge('good', 'check', 'On (BASIC_AUTH)') : badge('off', 'x', 'Off')}</td></tr>
          <tr><td class="muted">Admin password</td><td>${s.adminAuth ? badge('good', 'check', 'On (ADMIN_AUTH)') : badge('off', 'x', 'Off')}</td></tr>
          <tr><td class="muted">Behind a proxy</td><td>${s.trustProxy ? 'Trusts X-Forwarded-For (TRUST_PROXY)' : 'Uses the socket address'}</td></tr>
          <tr><td class="muted">Embedding allowed from</td><td class="mono">${h(s.frameAncestors)}</td></tr>
        </tbody></table></div>
        <p class="sub" style="margin-top:12px">No login is required by default. Before exposing the server on the internet, set <code>ADMIN_AUTH=user:password</code> (protects /admin) or <code>BASIC_AUTH=user:password</code> (protects everything) in the environment, and serve it over HTTPS (the installer can set up Caddy for you). <code>ADMIN_ENABLED=false</code> removes the dashboard entirely.</p>
      </section>
    </div>
    <section class="card"><h2>Backup & restore</h2>
      <p class="sub">The whole app state is one SQLite file in the data directory — back it up with any file backup, or download a consistent copy here.</p>
      <div class="row-actions">
        <a class="btn primary" href="api/admin/backup" data-icon="download"><span>Download database (.db)</span></a>
        <a class="btn" href="api/admin/export" data-icon="download"><span>Export all notes (JSON)</span></a>
        <button class="btn" id="sys-import" data-icon="upload"><span>Import notes (JSON)</span></button>
      </div>
      <p class="small muted">To restore a .db backup: stop the server, replace <code>cleantranslate.db</code> in the data directory (delete the -wal and -shm files next to it), start again.</p>
    </section>`);
  $('#sys-import').addEventListener('click', () => $('#adm-file').click());
}

$('#adm-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await api.post('api/admin/import', data);
    toast(`Imported ${r.created} notes`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, { type: 'error' });
  }
});

// ------------------------------------------------------------------ router
let ctlAbort = null;
function viewSignal() {
  return ctlAbort.signal;
}

const VIEWS = { overview: viewOverview, notes: viewNotes, engines: viewEngines, tags: viewTags, cache: viewCache, logs: viewLogs, api: viewApi, settings: viewSettings, system: viewSystem };

async function render() {
  const name = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const view = VIEWS[name] ? name : 'overview';
  if (view !== current) window.scrollTo(0, 0);
  current = view;
  ctlAbort?.abort();
  ctlAbort = new AbortController();
  $$('.adm-nav nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('#adm-title').textContent = TITLES[view];
  document.title = `${TITLES[view]} · ${$('#adm-name').textContent} admin`;
  $('#adm-nav').classList.remove('open');
  try {
    await VIEWS[view]();
  } catch (e) {
    setView(`<section class="card"><h2>Could not load this page</h2><p class="sub">${h(e.message)}</p><button class="btn" id="view-reload">Reload</button></section>`);
    $('#view-reload').addEventListener('click', () => location.reload());
  }
}

async function boot() {
  hydrateIcons();
  prefs.init({});
  const applyTheme = () => {
    document.documentElement.dataset.theme = prefs.get('theme');
    const dark = prefs.get('theme') === 'dark' || (prefs.get('theme') === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    setIcon($('#adm-theme'), dark ? 'sun' : 'moon');
  };
  applyTheme();
  $('#adm-theme').addEventListener('click', () => {
    const dark = prefs.get('theme') === 'dark' || (prefs.get('theme') === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    prefs.set('theme', dark ? 'light' : 'dark');
    applyTheme();
    render();
  });
  $('#adm-refresh').addEventListener('click', () => render());
  $('#adm-menu').addEventListener('click', () => $('#adm-nav').classList.toggle('open'));
  window.addEventListener('hashchange', render);
  try {
    const cfg = await api.get('api/config');
    $('#adm-name').textContent = cfg.instanceName;
    system = await api.get('api/admin/system');
    $('#adm-noauth').hidden = system.basicAuth || system.adminAuth;
  } catch { /* shown by the view */ }
  render();
}

boot();
