import { googleFree, googleBrowser, googleCloud } from './google.js';
import { edgeFree, azure } from './microsoft.js';
import { myMemory, lingva, libreTranslate } from './community.js';
import { deepl } from './deepl.js';
import { custom, middleman, echo } from './custom.js';

export { EngineError } from './base.js';

export const ENGINE_TYPES = Object.fromEntries(
  [googleFree, googleBrowser, edgeFree, lingva, myMemory, libreTranslate, deepl, googleCloud, azure, custom, middleman, echo]
    .map((t) => [t.type, t]),
);

// Built-in engine instances created on first start. Admins can reconfigure,
// disable, reorder and add more instances (e.g. a second LibreTranslate).
export const DEFAULT_ENGINES = [
  { id: 'google-free', type: 'google-free', name: 'Google Translate (free)', enabled: true, inAuto: true, priority: 10 },
  { id: 'edge-free', type: 'edge-free', name: 'Microsoft Edge (free)', enabled: true, inAuto: true, priority: 20 },
  { id: 'lingva', type: 'lingva', name: 'Lingva (Google mirror)', enabled: true, inAuto: true, priority: 30,
    config: { instances: 'https://lingva.ml\nhttps://lingva.lunar.icu\nhttps://translate.plausibility.cloud', timeout: 8000 } },
  { id: 'mymemory', type: 'mymemory', name: 'MyMemory', enabled: true, inAuto: true, priority: 40 },
  { id: 'google-browser', type: 'google-browser', name: 'Google (from your browser)', enabled: true, inAuto: false, priority: 5 },
  { id: 'libretranslate', type: 'libretranslate', name: 'LibreTranslate', enabled: false, inAuto: true, priority: 50,
    config: { url: 'http://libretranslate:5000' } },
  { id: 'deepl', type: 'deepl', name: 'DeepL', enabled: false, inAuto: true, priority: 60 },
  { id: 'google-cloud', type: 'google-cloud', name: 'Google Cloud Translation', enabled: false, inAuto: true, priority: 70 },
  { id: 'azure', type: 'azure', name: 'Azure Translator', enabled: false, inAuto: true, priority: 80 },
];

export function isConfigured(row) {
  const def = ENGINE_TYPES[row.type];
  if (!def) return false;
  return def.fields.every((f) => !f.required || String(row.config?.[f.key] ?? '').trim() !== '');
}

/** Copy of a config with secrets masked (for the admin UI). */
export function maskConfig(type, config) {
  const def = ENGINE_TYPES[type];
  const out = { ...config };
  for (const f of def?.fields || []) {
    if (f.type === 'password' && out[f.key]) {
      const v = String(out[f.key]);
      out[f.key] = v.length > 8 ? `••••${v.slice(-4)}` : '••••';
    }
  }
  return out;
}

export function isMasked(v) {
  return typeof v === 'string' && v.startsWith('••••');
}
