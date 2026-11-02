// Helpers for the free Google Translate web endpoint (client=gtx).
// Shared by the server engine ("google-free") and the in-browser engine
// ("google-browser"), so both batch and parse identically.
//
// Response shape (dt=t):  [[["Hola Mundo. ","Hello world. ",...], ...], null, "en", ...]
//   data[0][i][0] -> translated sentence chunk, data[2] -> detected source language.
// Rate limiting shows up as an HTTP 302 redirect to https://www.google.com/sorry/...
// (captcha) or as HTTP 429.

export const GTX_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
export const GTX_MAX_URL = 7000; // stay well below Google's GET URL limit

export function toGoogleLang(code) {
  if (!code || code === 'auto') return 'auto';
  if (code === 'he') return 'iw';
  if (code === 'jv') return 'jw';
  return code;
}

export function fromGoogleLang(code) {
  if (code === 'iw') return 'he';
  if (code === 'jw') return 'jv';
  return code || null;
}

export function buildGtxUrl(text, source, target, endpoint = GTX_ENDPOINT) {
  const params = new URLSearchParams({
    client: 'gtx', sl: toGoogleLang(source), tl: toGoogleLang(target), dt: 't', q: text,
  });
  return `${endpoint}?${params}`;
}

export function parseGtx(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Unexpected Google response format');
  let text = '';
  for (const seg of data[0]) if (Array.isArray(seg) && typeof seg[0] === 'string') text += seg[0];
  const detected = typeof data[2] === 'string' ? fromGoogleLang(data[2]) : null;
  return { text, detected };
}

/**
 * Group texts into newline-joined batches whose URL stays under `maxUrl`.
 * Texts that themselves contain a newline are always sent alone.
 * Returns arrays of indices into `texts`.
 */
export function planGtxBatches(texts, maxUrl = GTX_MAX_URL) {
  const base = 160; // endpoint + fixed params
  const batches = [];
  let cur = [];
  let len = base;
  texts.forEach((t, i) => {
    const enc = encodeURIComponent(t).length + 3; // + "%0A"
    if (/\n/.test(t) || enc + base > maxUrl) {
      if (cur.length) {
        batches.push(cur);
        cur = [];
        len = base;
      }
      batches.push([i]);
      return;
    }
    if (cur.length && len + enc > maxUrl) {
      batches.push(cur);
      cur = [];
      len = base;
    }
    cur.push(i);
    len += enc;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

/** Split a newline-joined translation back into `count` parts, or null on mismatch. */
export function splitJoined(text, count) {
  const parts = String(text).split(/\r?\n/);
  if (parts.length !== count) return null;
  return parts.map((p) => p.trim());
}
