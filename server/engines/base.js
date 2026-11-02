// Shared helpers for engine adapters.

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * kind: rate_limit | quota | auth | bad_request | unsupported | server | network | timeout | bad_response | config
 * rate_limit and quota put the engine into a cool-down so the auto chain skips it.
 */
export class EngineError extends Error {
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function http(url, { method = 'GET', headers = {}, body, timeout = 15000, redirect = 'follow', signal } = {}) {
  const timer = AbortSignal.timeout(timeout);
  const sig = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    return await fetch(url, { method, headers, body, redirect, signal: sig });
  } catch (e) {
    if (timer.aborted) throw new EngineError('timeout', `No answer within ${Math.round(timeout / 1000)} s`);
    if (signal?.aborted) throw new EngineError('timeout', 'Request cancelled');
    // Walk the cause chain: the innermost error is the useful one (ENOTFOUND, ECONNREFUSED, proxy 403...).
    let c = e;
    let detail = e.message;
    for (let i = 0; c && i < 5; i++, c = c.cause) {
      if (c.code && /^E[A-Z]+/.test(c.code)) detail = `${c.code}${c.hostname ? ` ${c.hostname}` : ''}`;
      else if (c.message && c.message !== 'fetch failed') detail = c.message;
    }
    throw new EngineError('network', `Network error: ${detail}`);
  }
}

export async function errorFromResponse(res, label) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || j.error || j.detail || j.responseDetails || text;
    } catch {
      detail = text;
    }
  } catch { /* ignore */ }
  detail = String(typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const s = res.status;
  const retryAfter = Number(res.headers.get('retry-after')) || undefined;
  const msg = `${label} HTTP ${s}${detail ? `: ${detail}` : ''}`;
  if (s === 429 || s === 529) return new EngineError('rate_limit', msg, { status: s, retryAfter });
  if (s === 456) return new EngineError('quota', msg, { status: s });
  if (s === 401 || s === 403) return new EngineError('auth', msg, { status: s });
  if (s >= 500) return new EngineError('server', msg, { status: s });
  return new EngineError('bad_request', msg, { status: s });
}

export async function jsonOrThrow(res, label) {
  if (!res.ok) throw await errorFromResponse(res, label);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError('bad_response', `${label} returned a non-JSON answer: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

export function parseHeaderLines(text) {
  const headers = {};
  if (!text) return headers;
  if (typeof text === 'object') return { ...text };
  const t = String(text).trim();
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch { /* fall through to lines */ }
  }
  for (const line of t.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

export function splitList(s) {
  return String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export const byteLength = (s) => Buffer.byteLength(s);

/**
 * Split text into pieces no longer than `max` (measured by `measure`), preferring
 * sentence boundaries, then word boundaries, then hard cuts.
 */
export function splitText(text, max, measure = (s) => s.length) {
  if (measure(text) <= max) return [text];
  const pieces = [];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  let cur = '';
  const push = () => {
    if (cur.trim()) pieces.push(cur.trim());
    cur = '';
  };
  for (const s of sentences) {
    if (measure(cur + s) <= max) { cur += s; continue; }
    push();
    if (measure(s) <= max) { cur = s; continue; }
    for (const w of s.split(/(\s+)/)) {
      if (measure(cur + w) <= max) { cur += w; continue; }
      push();
      if (measure(w) <= max) { cur = w; continue; }
      let chunk = '';
      for (const ch of w) {
        if (measure(chunk + ch) > max) { pieces.push(chunk); chunk = ''; }
        chunk += ch;
      }
      cur = chunk;
    }
  }
  push();
  return pieces;
}
