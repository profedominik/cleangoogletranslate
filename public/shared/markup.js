// CleanTranslate markup — shared by the browser editor and the Node server.
//
// A note is a list of lines. A line may start with one or more tag tokens:
//
//   [DIALOG]              on its own line  -> opens a DIALOG section
//   [/DIALOG]  or  [/]    on its own line  -> closes it (a new section also closes it)
//   [GRAMMAR] some text                    -> tags just this one line
//
// Tag kinds:
//   section  flat blocks (DIALOG, STORY...). Opening one closes the previous one.
//   span     overlays that live inside sections (NOTRANSLATE). Closed by their
//            closer or by any section boundary.
//   line     never opens a block; only tags the line it is on.
//
// Inline protection (never translated, MD-like):  `code`, {{var}}, ____ blanks, URLs.

export const TAG_STYLES = ['none', 'dialog', 'grammar', 'vocab', 'table', 'story', 'exercise', 'note'];
export const TAG_KINDS = ['section', 'span', 'line'];

export const DEFAULT_TAGS = [
  { name: 'DIALOG', color: '#2f6fde', kind: 'section', translate: true, style: 'dialog',
    description: 'Conversation. In "Ana: Hola" the speaker name is kept and only the speech is translated.' },
  { name: 'GRAMMAR', color: '#8b4fd8', kind: 'section', translate: true, style: 'grammar',
    description: 'Grammar explanation or rule.' },
  { name: 'VOCABULARY', color: '#1f9d55', kind: 'section', translate: true, style: 'vocab',
    description: 'Word list. In "term - meaning" lines the term is highlighted.' },
  { name: 'TABLE', color: '#e07b24', kind: 'section', translate: true, style: 'table',
    description: 'Rows with | separators are translated cell by cell so the columns survive.' },
  { name: 'STORY', color: '#d6455d', kind: 'section', translate: true, style: 'story',
    description: 'Reading passage or story.' },
  { name: 'EXERCISE', color: '#0e9f9a', kind: 'section', translate: true, style: 'exercise',
    description: 'Exercise. Blanks like ____ are kept intact.' },
  { name: 'NOTRANSLATE', color: '#7a8494', kind: 'span', translate: false, style: 'none',
    description: 'Never sent to a translator; the original is copied as-is. Works inside other sections.' },
];

// Offered as one-click additions in the admin "Tags" screen.
export const TAG_SUGGESTIONS = [
  { name: 'NOTE', color: '#c69214', kind: 'line', translate: true, style: 'note', description: 'Side note or reminder.' },
  { name: 'EXAMPLE', color: '#3b82f6', kind: 'section', translate: true, style: 'none', description: 'Examples.' },
  { name: 'PRONUNCIATION', color: '#a855f7', kind: 'section', translate: true, style: 'vocab', description: 'Pronunciation notes.' },
  { name: 'READING', color: '#ef4444', kind: 'section', translate: true, style: 'story', description: 'Reading text.' },
  { name: 'LISTENING', color: '#f97316', kind: 'section', translate: true, style: 'none', description: 'Listening activity.' },
  { name: 'HOMEWORK', color: '#14b8a6', kind: 'section', translate: true, style: 'exercise', description: 'Homework.' },
  { name: 'ANSWERS', color: '#64748b', kind: 'section', translate: true, style: 'exercise', description: 'Answer key.' },
  { name: 'CULTURE', color: '#db2777', kind: 'section', translate: true, style: 'none', description: 'Culture corner.' },
  { name: 'TIP', color: '#16a34a', kind: 'line', translate: true, style: 'note', description: 'Quick tip.' },
];

export function normalizeTag(t) {
  const name = String(t?.name || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  return {
    name,
    label: String(t?.label || name).slice(0, 40),
    color: /^#[0-9a-f]{3,8}$/i.test(t?.color || '') ? t.color : '#64748b',
    kind: TAG_KINDS.includes(t?.kind) ? t.kind : 'section',
    translate: t?.translate !== false,
    style: TAG_STYLES.includes(t?.style) ? t.style : 'none',
    description: String(t?.description || '').slice(0, 300),
  };
}

export function buildTagMap(tags = DEFAULT_TAGS) {
  const map = new Map();
  for (const raw of tags) {
    const t = normalizeTag(raw);
    if (t.name && /^[A-Z]/.test(t.name)) map.set(t.name, t);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

const TOKEN_RE = /^\[(\/?)([A-Za-z][A-Za-z0-9_-]{0,31})?\]/;

/**
 * Split a raw line into leading tag tokens and the remaining body.
 * Only tags known to `tagMap` are recognised; anything else stays in the body.
 * Exactly one space after a token is consumed (it is re-added by serializeLine).
 */
export function parseLine(text, tagMap) {
  const s = String(text ?? '');
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  const tokens = [];
  while (i < s.length && s[i] === '[') {
    const m = TOKEN_RE.exec(s.slice(i, i + 40));
    if (!m) break;
    const closing = m[1] === '/';
    const name = (m[2] || '').toUpperCase();
    if (closing ? name && !tagMap.has(name) : !name || !tagMap.has(name)) break;
    tokens.push({ name, closing });
    i += m[0].length;
    if (s[i] === ' ') i++;
  }
  if (!tokens.length) return { tokens, body: s, prefixLen: 0 };
  return { tokens, body: s.slice(i), prefixLen: i };
}

export function tokenText(t) {
  return `[${t.closing ? '/' : ''}${t.name}]`;
}

export function serializeLine(tokens, body) {
  if (!tokens || !tokens.length) return body ?? '';
  const pre = tokens.map(tokenText).join('');
  return body ? `${pre} ${body}` : pre;
}

const MD_PREFIX_RE = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+•][ \t]+|\d{1,3}[.)][ \t]+|[a-zA-Z][.)][ \t]+)/;
const HR_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

export function mdInfo(body) {
  const hr = HR_RE.test(body);
  const m = hr ? null : MD_PREFIX_RE.exec(body);
  const prefix = m ? m[0] : '';
  const t = prefix.trim();
  return {
    prefix,
    heading: t.startsWith('#') ? t.length : 0,
    quote: t.startsWith('>'),
    list: !!t && !t.startsWith('#') && !t.startsWith('>'),
    hr,
  };
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

/**
 * Analyse all lines of a note. Returns one info object per line:
 *  { tokens, body, prefixLen, role, inline, section, spans, translate, style, color, orphan, md }
 * role: 'open' | 'close' | 'marker' | 'inline' | 'text' | 'empty'
 */
export function analyze(texts, tagMap) {
  const out = new Array(texts.length);
  let section = null;
  let spans = [];
  for (let i = 0; i < texts.length; i++) {
    const p = parseLine(texts[i], tagMap);
    const bodyEmpty = !p.body.trim();
    const secBefore = section;
    const spansBefore = spans;
    const inline = [];
    let opened = false;
    let closed = false;
    let orphan = false;
    for (const t of p.tokens) {
      const def = t.name ? tagMap.get(t.name) : null;
      if (t.closing) {
        closed = true;
        if (!t.name) {
          if (spans.length) spans = spans.slice(0, -1);
          else if (section) section = null;
          else orphan = true;
        } else if (def.kind === 'span') {
          const k = spans.lastIndexOf(t.name);
          if (k >= 0) spans = spans.slice(0, k);
          else orphan = true;
        } else if (def.kind === 'section' && section === t.name) {
          section = null;
          spans = [];
        } else {
          orphan = true;
        }
      } else if (bodyEmpty && def.kind !== 'line') {
        opened = true;
        if (def.kind === 'section') {
          section = t.name;
          spans = [];
        } else if (!spans.includes(t.name)) {
          spans = [...spans, t.name];
        }
      } else {
        inline.push(t.name);
      }
    }

    let role;
    let lineSection = section;
    let lineSpans = spans;
    if (!bodyEmpty) role = inline.length ? 'inline' : 'text';
    else if (opened) role = 'open';
    else if (closed) {
      role = 'close';
      lineSection = secBefore;
      lineSpans = spansBefore;
    } else role = p.tokens.length ? 'marker' : 'empty';

    const defs = [];
    for (const n of inline) defs.push(tagMap.get(n));
    for (const n of lineSpans) defs.push(tagMap.get(n));
    if (lineSection) defs.push(tagMap.get(lineSection));
    const translate = defs.every((d) => !d || d.translate !== false);

    let style = 'none';
    for (const n of inline) {
      const st = tagMap.get(n)?.style;
      if (st && st !== 'none') { style = st; break; }
    }
    if (style === 'none' && lineSection) style = tagMap.get(lineSection)?.style || 'none';

    const spanColor = lineSpans.length ? tagMap.get(lineSpans[lineSpans.length - 1])?.color : null;
    out[i] = {
      tokens: p.tokens,
      body: p.body,
      prefixLen: p.prefixLen,
      role,
      inline,
      section: lineSection,
      spans: lineSpans,
      translate,
      style,
      color: lineSection ? tagMap.get(lineSection)?.color || null : spanColor,
      spanColor,
      orphan,
      md: mdInfo(p.body),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Translation plan: which parts of a line are sent to the engine
// ---------------------------------------------------------------------------

const DIALOG_RE = /^([^:：\n]{1,40}?)[ \t]*[:：][ \t]+/;
const HAS_LETTER = /\p{L}/u;

function isSpeaker(s) {
  const t = s.trim();
  if (!t || /[?!,;"“”¿¡.]$/.test(t) || /[?!;"“”¿¡]/.test(t)) return false;
  return t.split(/\s+/).length <= 4 && HAS_LETTER.test(t);
}

function pushSegment(parts, text) {
  if (!text) return;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (m[1]) parts.push({ keep: m[1] });
  if (m[2]) parts.push(HAS_LETTER.test(m[2]) ? { tr: m[2] } : { keep: m[2] });
  if (m[3]) parts.push({ keep: m[3] });
}

function mergeKeeps(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.keep != null && last && last.keep != null) last.keep += p.keep;
    else out.push({ ...p });
  }
  return out;
}

/**
 * Decide how a line is translated.
 *  { mode: 'none' }                      nothing to show (markers, empty lines)
 *  { mode: 'copy' }                      body copied verbatim (NOTRANSLATE, numbers, rules)
 *  { mode: 'translate', parts: [...] }   parts are {keep:string} or {tr:string}
 */
export function planLine(info) {
  const body = info.body;
  if (info.role === 'open' || info.role === 'close' || info.role === 'marker' || info.role === 'empty' || !body.trim()) {
    return { mode: 'none' };
  }
  if (!info.translate || info.md.hr) return { mode: 'copy' };
  const parts = [];
  let content = body;
  if (info.md.prefix) {
    parts.push({ keep: info.md.prefix });
    content = content.slice(info.md.prefix.length);
  }
  if (info.style === 'dialog') {
    const d = DIALOG_RE.exec(content);
    if (d && isSpeaker(d[1])) {
      parts.push({ keep: d[0] });
      content = content.slice(d[0].length);
    }
  }
  if (info.style === 'table' && content.includes('|')) {
    content.split('|').forEach((cell, idx) => {
      if (idx > 0) parts.push({ keep: '|' });
      pushSegment(parts, cell);
    });
  } else {
    pushSegment(parts, content);
  }
  if (!parts.some((p) => p.tr != null)) return { mode: 'copy' };
  return { mode: 'translate', parts: mergeKeeps(parts) };
}

export function planSegments(plan) {
  return plan.mode === 'translate' ? plan.parts.filter((p) => p.tr != null).map((p) => p.tr) : [];
}

/** Re-assemble a translated line from its plan and the translated segments (in order). */
export function assemble(plan, translated) {
  if (plan.mode !== 'translate') return '';
  let k = 0;
  let out = '';
  for (const p of plan.parts) out += p.keep != null ? p.keep : (translated[k++] ?? p.tr);
  return out;
}

/** Stable key: when it changes, the line needs a new translation. */
export function planKey(plan, source, target) {
  if (plan.mode !== 'translate') return plan.mode;
  return hash(`${source}>${target}|${JSON.stringify(plan.parts)}`);
}

// ---------------------------------------------------------------------------
// Inline protection (placeholders) — used by the server and the browser engine
// ---------------------------------------------------------------------------

const PROTECT_SRC = '`[^`\\n]+`|\\{\\{[^{}\\n]+\\}\\}|\\{\\d+\\}|_{3,}|https?:\\/\\/[^\\s<>"\'`]*[^\\s<>"\'`.,;:!?)\\]]';

export function protect(text) {
  const slots = [];
  const out = String(text).replace(new RegExp(PROTECT_SRC, 'g'), (m) => {
    slots.push(m);
    return `{${slots.length - 1}}`;
  });
  return { text: out, slots };
}

/** Put protected spans back. Returns null when the engine mangled the placeholders. */
export function restore(translated, slots) {
  if (!slots.length) return translated;
  const seen = new Array(slots.length).fill(0);
  let ok = true;
  const out = String(translated).replace(/\{\s*(\d+)\s*\}/g, (m, d) => {
    const k = Number(d);
    if (k >= slots.length) { ok = false; return m; }
    seen[k]++;
    return slots[k];
  });
  if (!ok || seen.some((c) => c !== 1)) return null;
  return out;
}

/** Split into protected / unprotected pieces (fallback when placeholders fail). */
export function splitProtected(text) {
  const re = new RegExp(PROTECT_SRC, 'g');
  const pieces = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) pieces.push({ text: text.slice(last, m.index), protected: false });
    pieces.push({ text: m[0], protected: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), protected: false });
  return pieces;
}

export function hasTranslatable(text) {
  return HAS_LETTER.test(String(text).replace(/\{\d+\}/g, ''));
}

// ---------------------------------------------------------------------------
// Syntax highlighting (runs cover the body exactly — no characters added/removed)
// ---------------------------------------------------------------------------

const VOCAB_RE = /^(.{1,60}?)([ \t]+[-–—=:][ \t]+)/;

export function highlight(body, style = 'none') {
  const n = body.length;
  if (!n) return [];
  const cls = new Array(n).fill('');
  const paint = (a, b, c) => { for (let i = Math.max(0, a); i < Math.min(n, b); i++) cls[i] = c; };

  const md = mdInfo(body);
  let pos = 0;
  if (md.hr) paint(0, n, 'md');
  else if (md.prefix) { paint(0, md.prefix.length, 'md'); pos = md.prefix.length; }
  const rest = body.slice(pos);

  if (style === 'dialog') {
    const d = DIALOG_RE.exec(rest);
    if (d && isSpeaker(d[1])) paint(pos, pos + d[0].length, 'speaker');
  } else if (style === 'vocab') {
    const v = VOCAB_RE.exec(rest);
    if (v) {
      paint(pos, pos + v[1].length, 'term');
      paint(pos + v[1].length, pos + v[0].length, 'sep');
    }
  } else if (style === 'table') {
    for (let i = pos; i < n; i++) if (body[i] === '|') cls[i] = 'pipe';
  }

  const re = new RegExp(PROTECT_SRC, 'g');
  let m;
  while ((m = re.exec(body))) {
    const c = m[0][0] === '`' ? 'code' : m[0][0] === '{' ? 'var' : m[0][0] === '_' ? 'blank' : 'url';
    paint(m.index, m.index + m[0].length, c);
  }

  const runs = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || cls[i] !== cls[start]) {
      runs.push([body.slice(start, i), cls[start]]);
      start = i;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** cyrb53 — small, fast, good-enough 53-bit string hash (base36). */
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function newId() {
  const a = new Uint8Array(8);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}

/**
 * Map old lines onto new texts (used after bulk editing) so unchanged lines keep
 * their id and translation. Returns [{ text, from: oldLine|null }].
 */
export function remapLines(oldLines, newTexts) {
  const n = oldLines.length;
  const m = newTexts.length;
  // Common prefix / suffix first (fast path for typical edits).
  let pre = 0;
  while (pre < n && pre < m && oldLines[pre].text === newTexts[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && oldLines[n - 1 - suf].text === newTexts[m - 1 - suf]) suf++;
  const result = newTexts.map((text) => ({ text, from: null }));
  for (let i = 0; i < pre; i++) result[i].from = oldLines[i];
  for (let k = 0; k < suf; k++) result[m - 1 - k].from = oldLines[n - 1 - k];
  // Middle: reuse lines with identical text (first come, first served).
  const pool = new Map();
  for (let i = pre; i < n - suf; i++) {
    const arr = pool.get(oldLines[i].text);
    if (arr) arr.push(oldLines[i]);
    else pool.set(oldLines[i].text, [oldLines[i]]);
  }
  for (let j = pre; j < m - suf; j++) {
    const arr = pool.get(newTexts[j]);
    if (arr && arr.length) result[j].from = arr.shift();
  }
  return result;
}
