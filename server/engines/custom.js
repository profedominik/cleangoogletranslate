import { EngineError, http, jsonOrThrow, trimSlash, parseHeaderLines } from './base.js';

/** Evaluate a tiny path language: "data.translations[].translatedText", "[0].text", "translatedText". */
export function getPath(obj, path) {
  if (!path) return obj;
  const tokens = String(path).replace(/\[(\d*)\]/g, '.[$1]').split('.').filter(Boolean);
  let cur = [obj];
  let multi = false;
  for (const t of tokens) {
    if (t === '[]') {
      multi = true;
      cur = cur.flatMap((v) => (Array.isArray(v) ? v : []));
    } else if (/^\[\d+\]$/.test(t)) {
      cur = cur.map((v) => v?.[Number(t.slice(1, -1))]);
    } else {
      cur = cur.map((v) => v?.[t]);
    }
  }
  return multi ? cur : cur[0];
}

export function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function templateVars(texts, source, target) {
  const text = texts[0] ?? '';
  const src = source || 'auto';
  return {
    texts: JSON.stringify(texts),
    text: JSON.stringify(text),
    text_raw: text,
    text_url: encodeURIComponent(text),
    source: src,
    target,
    SOURCE: src === 'auto' ? 'auto' : src.toUpperCase(),
    TARGET: target.toUpperCase(),
    source_or_empty: src === 'auto' ? '' : src,
    SOURCE_OR_EMPTY: src === 'auto' ? '' : src.toUpperCase(),
  };
}

export const CUSTOM_PRESETS = [
  {
    id: 'simple',
    label: 'Simple JSON (q / source / target)',
    config: {
      url: 'https://example.com/translate', method: 'POST', mode: 'batch', headers: 'Content-Type: application/json',
      body: '{"q": {{texts}}, "source": "{{source}}", "target": "{{target}}"}', responsePath: 'translations[]',
    },
  },
  {
    id: 'libre',
    label: 'LibreTranslate-compatible',
    config: {
      url: 'http://libretranslate:5000/translate', method: 'POST', mode: 'batch', headers: 'Content-Type: application/json',
      body: '{"q": {{texts}}, "source": "{{source}}", "target": "{{target}}", "format": "text"}', responsePath: 'translatedText',
    },
  },
  {
    id: 'dlx',
    label: 'DLX / DeepLX (self-hosted, unofficial DeepL)',
    config: {
      url: 'http://deeplx:1188/translate', method: 'POST', mode: 'batch', headers: 'Content-Type: application/json',
      body: '{"text": {{texts}}, "source_lang": "{{SOURCE_OR_EMPTY}}", "target_lang": "{{TARGET}}"}', responsePath: 'data',
      maxChars: 1500,
    },
  },
  {
    id: 'lingva',
    label: 'Lingva-compatible (GET)',
    config: {
      url: 'https://lingva.ml/api/v1/{{source}}/{{target}}/{{text_url}}', method: 'GET', mode: 'single', headers: '',
      body: '', responsePath: 'translation',
    },
  },
];

export const custom = {
  type: 'custom',
  label: 'Custom HTTP / JSON API',
  category: 'custom',
  signup: 'Depends on the service',
  serverSide: true,
  docs: '',
  description: 'Point CleanTranslate at any translation API that speaks JSON. Use a preset or describe the request with a template.',
  notes: [
    'Placeholders: {{texts}} (JSON array), {{text}} (JSON string), {{text_raw}}, {{text_url}}, {{source}}, {{target}}, {{SOURCE}}/{{TARGET}} (upper-case), {{source_or_empty}}.',
    'Mode "batch" sends all lines in one request and expects an array back; "single" sends one request per line.',
    'Response path examples: translations[] · translations[].text · data.translations[].translatedText · [].translations[0].text · data',
    'Requests are made from the server, so internal Docker hostnames (http://deeplx:1188) work.',
  ],
  limits: { label: 'Depends on the service' },
  fields: [
    { key: 'url', label: 'URL (placeholders allowed)', type: 'url', required: true },
    { key: 'method', label: 'Method', type: 'select', options: ['POST', 'GET', 'PUT'] },
    { key: 'mode', label: 'Mode', type: 'select', options: ['batch', 'single'] },
    { key: 'headers', label: 'Headers (one "Name: value" per line)', type: 'textarea' },
    { key: 'body', label: 'Body template', type: 'textarea' },
    { key: 'responsePath', label: 'Response path', type: 'text', required: true },
    { key: 'detectedPath', label: 'Detected-language path (optional)', type: 'text' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '20000' },
    { key: 'maxChars', label: 'Max characters per request', type: 'number', placeholder: '8000' },
  ],
  presets: CUSTOM_PRESETS,
  batch: { maxItems: 50, maxChars: 8000 },
  concurrency: 2,
  create(cfg) {
    const method = (cfg.method || 'POST').toUpperCase();
    const headers = parseHeaderLines(cfg.headers);
    const call = async (texts, source, target, signal) => {
      const vars = templateVars(texts, source, target);
      const url = renderTemplate(cfg.url || '', { ...vars, texts: encodeURIComponent(vars.texts), text: vars.text_url });
      if (!/^https?:\/\//i.test(url)) throw new EngineError('config', 'Custom engine URL must start with http:// or https://');
      const init = { method, headers: { ...headers }, timeout: Number(cfg.timeout) || 20000, signal };
      if (method !== 'GET' && cfg.body) {
        init.body = renderTemplate(cfg.body, vars);
        if (!Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')) init.headers['Content-Type'] = 'application/json';
      }
      const data = await jsonOrThrow(await http(url, init), 'Custom engine');
      const value = getPath(data, cfg.responsePath);
      const det = cfg.detectedPath ? getPath(data, cfg.detectedPath) : null;
      return { value, det };
    };
    return {
      async translate({ texts, source, target, signal }) {
        if (cfg.mode === 'single') {
          const out = [];
          let detected = null;
          for (const t of texts) {
            const { value, det } = await call([t], source, target, signal);
            const v = Array.isArray(value) ? value[0] : value;
            if (typeof v !== 'string') throw new EngineError('bad_response', `Response path "${cfg.responsePath}" did not return a string`);
            out.push(v);
            detected ||= typeof det === 'string' ? det : null;
          }
          return { translations: out, detected, requests: texts.length };
        }
        const { value, det } = await call(texts, source, target, signal);
        const arr = Array.isArray(value) ? value : texts.length === 1 && typeof value === 'string' ? [value] : null;
        if (!arr || arr.length !== texts.length || arr.some((v) => typeof v !== 'string')) {
          throw new EngineError('bad_response', `Response path "${cfg.responsePath}" did not return ${texts.length} string(s)`);
        }
        return { translations: arr, detected: Array.isArray(det) ? det : typeof det === 'string' ? det : null };
      },
    };
  },
};

export const middleman = {
  type: 'middleman',
  label: 'Another CleanTranslate instance (middleman API)',
  category: 'custom',
  signup: 'None (API key if the remote instance requires one)',
  serverSide: true,
  docs: '',
  description: 'Forward translations to another CleanTranslate server (POST /api/v1/translate) — e.g. a hub on a different IP, or one that holds the paid API keys.',
  notes: [
    'Use it to share one translation hub between several apps or servers, or to route requests through a server on another IP when this one is rate-limited.',
    'The remote engine can be "auto" (its own fallback chain) or a specific engine id.',
    'Any service implementing the same API ({ q, source, target } → { translations: [{ text }] }) works too.',
  ],
  limits: { label: 'Depends on the remote instance' },
  fields: [
    { key: 'url', label: 'Base URL', type: 'url', required: true, placeholder: 'https://translate.example.com' },
    { key: 'apiKey', label: 'API key', type: 'password' },
    { key: 'remoteEngine', label: 'Remote engine id', type: 'text', placeholder: 'auto' },
  ],
  batch: { maxItems: 100, maxChars: 20000 },
  concurrency: 2,
  create(cfg) {
    return {
      async translate({ texts, source, target, signal }) {
        const base = trimSlash(cfg.url);
        if (!base) throw new EngineError('config', 'Middleman URL not configured');
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const res = await http(`${base}/api/v1/translate`, {
          method: 'POST', headers, signal, timeout: 30000,
          body: JSON.stringify({ q: texts, source, target, engine: cfg.remoteEngine || 'auto' }),
        });
        const data = await jsonOrThrow(res, 'Middleman');
        const tr = data.translations;
        if (!Array.isArray(tr) || tr.length !== texts.length) throw new EngineError('bad_response', 'Middleman returned an unexpected answer');
        if (tr.some((t) => t == null || t.text == null)) {
          throw new EngineError('server', `Remote instance could not translate: ${data.errors?.[0]?.message || 'unknown error'}`);
        }
        return { translations: tr.map((t) => t.text), detected: tr.map((t) => t.detectedSourceLanguage || null) };
      },
    };
  },
};

export const echo = {
  type: 'echo',
  label: 'Echo (offline test engine)',
  category: 'test',
  signup: 'None',
  serverSide: true,
  docs: '',
  description: 'Does not translate: returns the text transformed locally. Useful to test the pipeline, the editor and fallbacks without any network.',
  notes: ['For testing only. "fail" lets you simulate a rate-limited or broken engine to watch the auto chain fall through.'],
  limits: { label: 'Unlimited (local)' },
  fields: [
    { key: 'mode', label: 'Transform', type: 'select', options: ['upper', 'prefix', 'reverse-words'] },
    { key: 'delay', label: 'Artificial delay (ms)', type: 'number', placeholder: '0' },
    { key: 'fail', label: 'Simulate failure', type: 'select', options: ['none', 'rate_limit', 'server'] },
  ],
  batch: { maxItems: 200, maxChars: 50000 },
  concurrency: 4,
  create(cfg) {
    return {
      async translate({ texts, target }) {
        const delay = Number(cfg.delay) || 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (cfg.fail === 'rate_limit') throw new EngineError('rate_limit', 'Simulated rate limit');
        if (cfg.fail === 'server') throw new EngineError('server', 'Simulated server error');
        const f = cfg.mode === 'prefix' ? (t) => `[${target}] ${t}`
          : cfg.mode === 'reverse-words' ? (t) => t.split(' ').reverse().join(' ')
            : (t) => t.toUpperCase();
        return { translations: texts.map(f), detected: 'en' };
      },
    };
  },
};
