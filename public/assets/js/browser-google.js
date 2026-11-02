// In-browser Google Translate (free gtx endpoint, which allows cross-origin calls).
// Requests come from the visitor's own IP, avoiding captcha blocks on shared VPS IPs.
import { buildGtxUrl, parseGtx, planGtxBatches, splitJoined } from '../../shared/gtx.js';
import { protect, restore, splitProtected } from '../../shared/markup.js';

let lastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gtx(text, source, target) {
  const wait = lastAt + 180 - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  let res;
  try {
    res = await fetch(buildGtxUrl(text, source, target), { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch {
    throw new Error('Your browser could not reach translate.googleapis.com');
  }
  if (res.type === 'opaqueredirect' || res.status === 429) throw new Error('Google is rate-limiting this browser for now (captcha). Try again later or pick another engine.');
  if (!res.ok) throw new Error(`Google answered HTTP ${res.status}`);
  return parseGtx(await res.json());
}

async function translateRaw(texts, source, target) {
  const out = new Array(texts.length);
  let detected = null;
  let requests = 0;
  for (const idxs of planGtxBatches(texts)) {
    if (idxs.length === 1) {
      const r = await gtx(texts[idxs[0]], source, target);
      requests++;
      out[idxs[0]] = r.text.trim();
      detected ||= r.detected;
      continue;
    }
    const r = await gtx(idxs.map((i) => texts[i]).join('\n'), source, target);
    requests++;
    detected ||= r.detected;
    const parts = splitJoined(r.text, idxs.length);
    if (parts) idxs.forEach((i, k) => { out[i] = parts[k]; });
    else {
      for (const i of idxs) {
        out[i] = (await gtx(texts[i], source, target)).text.trim();
        requests++;
      }
    }
  }
  return { out, detected, requests };
}

/** Translate texts with inline protection. Returns { results: [{text, detected, engine}], requests }. */
export async function browserTranslate(texts, source, target) {
  const prepared = texts.map((t) => protect(t));
  const r = await translateRaw(prepared.map((p) => p.text), source, target);
  let requests = r.requests;
  const results = new Array(texts.length);
  const redo = [];
  prepared.forEach((p, k) => {
    const v = restore(r.out[k], p.slots);
    if (v == null) redo.push(k);
    else results[k] = { text: v, detected: r.detected, engine: 'google-browser' };
  });
  if (redo.length) {
    const pieceTexts = [];
    const jobs = redo.map((k) => ({
      k,
      pieces: splitProtected(texts[k]).map((pc) => {
        if (pc.protected) return { keep: pc.text };
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(pc.text);
        if (!m[2] || !/\p{L}/u.test(m[2])) return { keep: pc.text };
        pieceTexts.push(m[2]);
        return { lead: m[1], idx: pieceTexts.length - 1, trail: m[3] };
      }),
    }));
    const pr = pieceTexts.length ? await translateRaw(pieceTexts, source, target) : { out: [], requests: 0 };
    requests += pr.requests;
    for (const { k, pieces } of jobs) {
      results[k] = {
        text: pieces.map((p) => (p.keep != null ? p.keep : p.lead + pr.out[p.idx] + p.trail)).join(''),
        detected: r.detected,
        engine: 'google-browser',
      };
    }
  }
  return { results, requests, detected: r.detected };
}
