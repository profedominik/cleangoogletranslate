import { EngineError, http, jsonOrThrow, trimSlash } from './base.js';

export const DEEPL_TARGETS = new Set([
  'AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN-GB', 'EN-US', 'ES', 'ET', 'FI', 'FR', 'HE', 'HU', 'ID', 'IT', 'JA', 'KO',
  'LT', 'LV', 'NB', 'NL', 'PL', 'PT-BR', 'PT-PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TH', 'TR', 'UK', 'VI', 'ZH-HANS', 'ZH-HANT',
]);

export function deeplTarget(code, cfg = {}) {
  switch (code) {
    case 'en': return cfg.englishVariant === 'EN-GB' ? 'EN-GB' : 'EN-US';
    case 'pt': return cfg.portugueseVariant === 'PT-PT' ? 'PT-PT' : 'PT-BR';
    case 'zh-CN': return 'ZH-HANS';
    case 'zh-TW': return 'ZH-HANT';
    case 'no': return 'NB';
    default: return code.split('-')[0].toUpperCase();
  }
}

export function deeplSource(code) {
  if (!code || code === 'auto') return null;
  if (code === 'no') return 'NB';
  return code.split('-')[0].toUpperCase();
}

const BACK = { NB: 'no', ZH: 'zh-CN', HE: 'he' };

export const deepl = {
  type: 'deepl',
  label: 'DeepL API (Free or Pro)',
  category: 'key',
  signup: 'DeepL account (card needed for verification)',
  serverSide: true,
  docs: 'https://developers.deepl.com/docs',
  description: 'DeepL API — excellent quality for the ~30 languages it supports.',
  notes: [
    'Requires a DeepL API account (deepl.com/pro-api). The Free plan asks for a credit card for verification but is not charged.',
    'DeepL API Free: 500,000 characters per month. Free keys end with ":fx" and automatically use api-free.deepl.com.',
    'Supports about 30+ languages (most European languages, Arabic, Chinese, Hebrew, Indonesian, Japanese, Korean, Thai, Turkish, Ukrainian, Vietnamese…). Unsupported pairs fall through to the next engine in the auto chain.',
    'Self-hosted alternative without an account: DLX, formerly DeepLX (unofficial, ~1500 characters per request) — add it as a Custom engine with the DLX preset.',
  ],
  limits: { perMonth: 500000, label: '500,000 chars / month (Free plan)' },
  fields: [
    { key: 'apiKey', label: 'Authentication key', type: 'password', required: true },
    { key: 'englishVariant', label: 'English variant', type: 'select', options: ['EN-US', 'EN-GB'] },
    { key: 'portugueseVariant', label: 'Portuguese variant', type: 'select', options: ['PT-BR', 'PT-PT'] },
    { key: 'formality', label: 'Formality', type: 'select', options: ['default', 'prefer_more', 'prefer_less'] },
    { key: 'endpoint', label: 'Endpoint (optional)', type: 'url', placeholder: 'auto: api-free.deepl.com for :fx keys' },
  ],
  batch: { maxItems: 50, maxChars: 25000 }, // request body limit is 128 KiB
  concurrency: 2,
  create(cfg) {
    return {
      async translate({ texts, source, target, signal }) {
        const key = String(cfg.apiKey || '').trim();
        if (!key) throw new EngineError('config', 'DeepL key not configured');
        const tl = deeplTarget(target, cfg);
        if (!DEEPL_TARGETS.has(tl)) throw new EngineError('unsupported', `DeepL does not support target language "${target}"`);
        const host = trimSlash(cfg.endpoint) || (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com');
        const body = { text: texts, target_lang: tl };
        const sl = deeplSource(source);
        if (sl) body.source_lang = sl;
        if (cfg.formality && cfg.formality !== 'default') body.formality = cfg.formality;
        const res = await http(`${host}/v2/translate`, {
          method: 'POST',
          headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        const data = await jsonOrThrow(res, 'DeepL');
        const tr = data.translations;
        if (!Array.isArray(tr) || tr.length !== texts.length) throw new EngineError('bad_response', 'DeepL returned an unexpected answer');
        return {
          translations: tr.map((t) => t.text ?? ''),
          detected: tr.map((t) => (t.detected_source_language ? BACK[t.detected_source_language] || t.detected_source_language.toLowerCase() : null)),
        };
      },
    };
  },
};
