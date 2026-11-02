import { DEFAULT_TAGS, normalizeTag } from '../public/shared/markup.js';
import { normalizeLang } from '../public/shared/languages.js';
import { HttpError } from './http.js';

export const DEFAULT_SETTINGS = {
  instanceName: 'CleanTranslate',
  defaultSource: 'auto',
  defaultTarget: 'en',
  defaultEngine: 'auto',
  autosaveDelayMs: 800,
  translateDelayMs: 450,
  revisionIntervalMin: 10,
  revisionKeep: 50,
  trashDays: 30,
  cacheEnabled: true,
  cacheMaxEntries: 300000,
  cooldownSec: 60,
  browserFallback: true,
  apiEnabled: true,
  apiKey: '',
  apiCors: '*',
  apiRateLimit: 120,
  frameAncestors: '*',
  tags: DEFAULT_TAGS,
  ui: {
    lineNumbers: true,
    zebra: true,
    highlight: true,
    showTranslation: true,
    layout: 'auto',
    fontSize: 16,
    theme: 'auto',
  },
};

const int = (min, max) => (v) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be a number between ${min} and ${max}`);
  return n;
};
const str = (max) => (v) => String(v ?? '').slice(0, max);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';

const UI_RULES = {
  lineNumbers: bool,
  zebra: bool,
  highlight: bool,
  showTranslation: bool,
  layout: (v) => (['auto', 'side', 'stacked'].includes(v) ? v : 'auto'),
  fontSize: int(10, 32),
  theme: (v) => (['auto', 'light', 'dark'].includes(v) ? v : 'auto'),
};

const RULES = {
  instanceName: (v) => str(60)(v).trim() || 'CleanTranslate',
  defaultSource: (v) => {
    const n = normalizeLang(v);
    if (!n) throw new Error('unknown language');
    return n;
  },
  defaultTarget: (v) => {
    const n = normalizeLang(v, { allowAuto: false });
    if (!n) throw new Error('unknown language');
    return n;
  },
  defaultEngine: (v) => str(64)(v) || 'auto',
  autosaveDelayMs: int(200, 10000),
  translateDelayMs: int(100, 10000),
  revisionIntervalMin: int(1, 1440),
  revisionKeep: int(1, 1000),
  trashDays: int(1, 3650),
  cacheEnabled: bool,
  cacheMaxEntries: int(1000, 10000000),
  cooldownSec: int(10, 3600),
  browserFallback: bool,
  apiEnabled: bool,
  apiKey: (v) => str(200)(v).trim(),
  apiCors: (v) => str(500)(v).replace(/[\r\n]/g, '').trim(),
  apiRateLimit: int(0, 100000),
  frameAncestors: (v) => str(500)(v).replace(/[;\r\n]/g, '').trim() || "'self'",
  tags: (v) => {
    if (!Array.isArray(v)) throw new Error('must be a list');
    const seen = new Set();
    const out = [];
    for (const raw of v.slice(0, 100)) {
      const t = normalizeTag(raw);
      if (!t.name || !/^[A-Z]/.test(t.name) || seen.has(t.name)) continue;
      seen.add(t.name);
      out.push(t);
    }
    return out;
  },
  ui: (v) => {
    if (!v || typeof v !== 'object') throw new Error('must be an object');
    const out = {};
    for (const [k, rule] of Object.entries(UI_RULES)) if (k in v) out[k] = rule(v[k]);
    return { ...DEFAULT_SETTINGS.ui, ...out };
  },
};

export function createSettings(store) {
  let cache = null;
  const get = () => {
    if (!cache) {
      const stored = store.allSettings();
      cache = { ...DEFAULT_SETTINGS, ...stored, ui: { ...DEFAULT_SETTINGS.ui, ...(stored.ui || {}) } };
    }
    return cache;
  };
  const set = (patch) => {
    if (!patch || typeof patch !== 'object') throw new HttpError(400, 'Settings must be an object');
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!RULES[k]) continue;
      try {
        clean[k] = RULES[k](v);
      } catch (e) {
        throw new HttpError(400, `Setting "${k}" ${e.message}`);
      }
    }
    store.tx(() => { for (const [k, v] of Object.entries(clean)) store.setSetting(k, v); });
    cache = null;
    return get();
  };
  const reset = (key) => {
    store.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    cache = null;
    return get();
  };
  return { get, set, reset };
}
