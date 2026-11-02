// Note exports: txt, md, csv, html (printable side-by-side), json.
import { analyze, planLine, serializeLine, highlight } from '../public/shared/markup.js';
import { languageName } from '../public/shared/languages.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Per-line view used by all exporters. */
export function exportRows(note, tagMap) {
  const info = analyze(note.lines.map((l) => l.text), tagMap);
  return note.lines.map((l, i) => {
    const inf = info[i];
    const plan = planLine(inf);
    let trBody = '';
    if (plan.mode === 'copy') trBody = inf.body;
    else if (plan.mode === 'translate') trBody = l.tr || '';
    const marker = inf.role === 'open' || inf.role === 'close' || inf.role === 'marker';
    return {
      n: i + 1,
      info: inf,
      original: l.text,
      originalBody: inf.body,
      translation: marker ? l.text : inf.role === 'empty' ? '' : serializeLine(inf.tokens, trBody),
      translationBody: trBody,
      marker,
    };
  });
}

function hlHtml(body, style) {
  return highlight(body, style).map(([t, c]) => (c ? `<span class="h-${c}">${esc(t)}</span>` : esc(t))).join('');
}

function pills(inf, tagMap) {
  return inf.tokens.map((t) => {
    const def = tagMap.get(t.name);
    const color = def?.color || '#64748b';
    const label = t.closing ? `/${t.name || ''}` : t.name;
    return `<span class="pill" style="--c:${esc(color)}">${esc(label)}</span>`;
  }).join('');
}

function htmlDoc(note, rows, side, tagMap, title) {
  const both = side === 'both';
  const showOrig = side !== 'translation';
  const showTr = side !== 'original';
  const body = rows.map((r) => {
    const inf = r.info;
    const color = inf.color ? ` style="--sec:${esc(inf.color)}"` : '';
    const cls = [inf.section || inf.spans.length ? 'insec' : '', inf.role, inf.md.heading ? `h${inf.md.heading}` : '', !inf.translate ? 'notr' : '', `st-${inf.style}`].filter(Boolean).join(' ');
    const o = `<td class="src">${pills(inf, tagMap)}${hlHtml(r.originalBody, inf.style)}</td>`;
    const t = `<td class="tr">${r.marker ? pills(inf, tagMap) : pills({ tokens: inf.tokens.filter(() => inf.role === 'inline') }, tagMap) + hlHtml(r.translationBody, inf.style)}</td>`;
    return `<tr class="${cls}"${color}><td class="n">${r.n}</td>${showOrig ? o : ''}${showTr ? t : ''}</tr>`;
  }).join('\n');
  const head = `<tr><th class="n">#</th>${showOrig ? `<th>${esc(languageName(note.sourceLang))}</th>` : ''}${showTr ? `<th>${esc(languageName(note.targetLang))}</th>` : ''}</tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; --line: #e3e6ea; --muted: #6b7280; }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 2px solid var(--line); padding: 6px 10px; }
  td { vertical-align: top; padding: 4px 10px; border-bottom: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
  td.n, th.n { width: 3em; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
  tr:nth-child(even) td { background: #f7f8fa; }
  tr.insec td.src, tr.insec td.tr { box-shadow: inset 3px 0 0 var(--sec, #94a3b8); }
  tr.notr td.tr { color: var(--muted); font-style: italic; }
  tr.h1 td { font-size: 1.5em; font-weight: 700; } tr.h2 td { font-size: 1.3em; font-weight: 700; } tr.h3 td { font-weight: 700; }
  tr.st-story td.src, tr.st-story td.tr { font-family: Georgia, "Times New Roman", serif; }
  tr.st-table td.src, tr.st-table td.tr { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
  .pill { display: inline-block; font: 600 11px/1.6 system-ui, sans-serif; letter-spacing: .04em; padding: 0 8px; border-radius: 999px; color: #fff; background: var(--c); margin-right: 6px; vertical-align: 1px; }
  .h-speaker, .h-term { font-weight: 700; } .h-code { font-family: ui-monospace, monospace; background: #eef1f4; border-radius: 4px; }
  .h-blank { letter-spacing: .1em; } .h-md, .h-pipe, .h-sep { color: var(--muted); } .h-url { color: #2563eb; }
  @media print { body { margin: 0; } tr { break-inside: avoid; } }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">${esc(languageName(note.sourceLang))} → ${esc(languageName(note.targetLang))} · ${rows.length} lines · ${new Date(note.updatedAt || Date.now()).toLocaleString('en-GB')}</div>
<table class="${both ? 'both' : side}">
<thead>${head}</thead>
<tbody>
${body}
</tbody></table>
</body></html>`;
}

function csvCell(s) {
  const v = String(s ?? '');
  return /[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|') || ' ';
}

export function renderExport(note, { format = 'txt', side = 'original', tagMap, title }) {
  const rows = exportRows(note, tagMap);
  const name = title || note.title || 'note';
  switch (format) {
    case 'json':
      return { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify({ ...note, exportedAt: new Date().toISOString(), format: 'cleantranslate-note@1' }, null, 2) };
    case 'csv': {
      const lines = [['#', languageName(note.sourceLang), languageName(note.targetLang)].map(csvCell).join(',')];
      for (const r of rows) lines.push([r.n, r.original, r.translation].map(csvCell).join(','));
      return { type: 'text/csv; charset=utf-8', ext: 'csv', body: '﻿' + lines.join('\r\n') + '\r\n' };
    }
    case 'html':
      return { type: 'text/html; charset=utf-8', ext: 'html', body: htmlDoc(note, rows, side, tagMap, name) };
    case 'md': {
      if (side === 'both') {
        const out = [`# ${name}`, '', `| # | ${languageName(note.sourceLang)} | ${languageName(note.targetLang)} |`, '|---:|---|---|'];
        for (const r of rows) out.push(`| ${r.n} | ${mdCell(r.original)} | ${mdCell(r.translation)} |`);
        return { type: 'text/markdown; charset=utf-8', ext: 'md', body: out.join('\n') + '\n' };
      }
      const lines = rows.map((r) => (side === 'translation' ? r.translation : r.original));
      return { type: 'text/markdown; charset=utf-8', ext: 'md', body: lines.join('\n') + '\n' };
    }
    default: {
      let body;
      if (side === 'both') body = rows.map((r) => (r.original || r.translation ? `${r.original}\n    ${r.translation}` : '')).join('\n');
      else body = rows.map((r) => (side === 'translation' ? r.translation : r.original)).join('\n');
      return { type: 'text/plain; charset=utf-8', ext: 'txt', body: body + '\n' };
    }
  }
}

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'note';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
