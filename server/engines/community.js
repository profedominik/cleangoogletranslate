import { planGtxBatches, splitJoined } from '../../public/shared/gtx.js';
import { EngineError, http, jsonOrThrow, decodeEntities, trimSlash, splitList, splitText, byteLength } from './base.js';

// ----------------------------------------------------------------- MyMemory

const MYMEMORY_MAX_BYTES = 480; // API limit is 500 bytes per query

export const myMemory = {
  type: 'mymemory',
  label: 'MyMemory (Translated.net)',
  category: 'free',
  signup: 'None (optional email raises the quota)',
  serverSide: true,
  docs: 'https://mymemory.translated.net/doc/spec.php',
  description: 'Free translation-memory API mixing human translations with machine translation.',
  notes: [
    'Free, no signup. Anonymous use: about 5,000 characters per day per IP.',
    'Add a valid email in the settings below (sent as the "de" parameter) to raise the free quota to about 50,000 characters per day.',
    'Each request is limited to 500 bytes, so long lines are split into sentences automatically (one request per piece — slower).',
    'Works best with an explicit source language; quality varies with the language pair.',
    'When the daily quota is used up the engine is cooled down until midnight UTC.',
  ],
  limits: { perDay: 5000, label: '5,000 chars / day (50,000 with email)' },
  fields: [
    { key: 'email', label: 'Email (raises the free quota)', type: 'text', placeholder: 'you@example.com' },
    { key: 'apiKey', label: 'API key (optional, paid plans)', type: 'password' },
  ],
  batch: { maxItems: 20, maxChars: 4000, maxItemBytes: MYMEMORY_MAX_BYTES },
  concurrency: 2,
  minInterval: 150,
  create(cfg) {
    const one = async (q, source, target, signal) => {
      const params = new URLSearchParams({ q, langpair: `${source === 'auto' ? 'Autodetect' : source}|${target}` });
      if (cfg.email) params.set('de', cfg.email);
      if (cfg.apiKey) params.set('key', cfg.apiKey);
      const res = await http(`https://api.mymemory.translated.net/get?${params}`, { signal });
      const data = await jsonOrThrow(res, 'MyMemory');
      const status = Number(data.responseStatus);
      const text = String(data.responseData?.translatedText ?? '');
      if (data.quotaFinished || /MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS/i.test(text) || status === 429) {
        throw new EngineError('quota', `MyMemory daily quota used up: ${String(data.responseDetails || text).slice(0, 160)}`);
      }
      if (status !== 200) {
        const kind = status === 403 ? 'unsupported' : 'bad_request';
        throw new EngineError(kind, `MyMemory: ${String(data.responseDetails || text || status).slice(0, 200)}`, { status });
      }
      return { text: decodeEntities(text), detected: data.responseData?.detectedLanguage || null };
    };
    return {
      async translate({ texts, source, target, signal }) {
        const out = [];
        let detected = null;
        let requests = 0;
        for (const t of texts) {
          const parts = splitText(t, MYMEMORY_MAX_BYTES, byteLength);
          const tr = [];
          for (const p of parts) {
            const r = await one(p, source, target, signal);
            requests++;
            tr.push(r.text);
            detected ||= r.detected;
          }
          out.push(tr.join(' '));
        }
        return { translations: out, detected, requests };
      },
    };
  },
};

// ----------------------------------------------------------------- Lingva

const LINGVA_MAP = { 'zh-CN': 'zh', 'zh-TW': 'zh_HANT', he: 'iw', jv: 'jw' };
const LINGVA_BACK = { zh: 'zh-CN', zh_HANT: 'zh-TW', iw: 'he', jw: 'jv' };

export const lingva = {
  type: 'lingva',
  label: 'Lingva Translate (Google front-end)',
  category: 'free',
  signup: 'None',
  serverSide: true,
  docs: 'https://github.com/thedaviddelta/lingva-translate',
  description: 'Open-source alternative front-end for Google Translate. Calls a Lingva instance which fetches the Google translation for you.',
  notes: [
    'Free, no account. Translation quality is the same as Google Translate.',
    'Public instances are run by volunteers and come and go (the project README lists e.g. lingva.ml, lingva.lunar.icu, translate.plausibility.cloud, translate.projectsegfau.lt, lingva.garudalinux.org); list several and they are tried in order.',
    'Best option: self-host it (Docker image thedaviddelta/lingva-translate) — it then uses your instance\'s IP for Google.',
    'Requests come from the instance\'s IP, so it can keep working when your own server IP is captcha-blocked by Google.',
  ],
  limits: { label: 'Depends on the instance' },
  fields: [
    { key: 'instances', label: 'Instance URLs (one per line, tried in order)', type: 'textarea', required: true,
      placeholder: 'https://lingva.ml\nhttps://lingva.lunar.icu\nhttps://translate.plausibility.cloud' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000' },
  ],
  batch: { maxItems: 50, maxChars: 3000, maxItemChars: 700 },
  concurrency: 2,
  minInterval: 100,
  create(cfg) {
    const instances = splitList(cfg.instances).map(trimSlash);
    let preferred = 0;
    const call = async (text, source, target, signal) => {
      if (!instances.length) throw new EngineError('config', 'No Lingva instance configured');
      let lastErr;
      for (let k = 0; k < instances.length; k++) {
        const idx = (preferred + k) % instances.length;
        const sl = source === 'auto' ? 'auto' : LINGVA_MAP[source] || source;
        const tl = LINGVA_MAP[target] || target;
        try {
          const res = await http(`${instances[idx]}/api/v1/${encodeURIComponent(sl)}/${encodeURIComponent(tl)}/${encodeURIComponent(text)}`, {
            timeout: Number(cfg.timeout) || 10000, signal,
          });
          const data = await jsonOrThrow(res, 'Lingva');
          if (typeof data.translation !== 'string') throw new EngineError('bad_response', data.error || 'Lingva returned no translation');
          preferred = idx;
          const det = data.info?.detectedSource;
          return { text: data.translation, detected: det ? LINGVA_BACK[det] || det : null };
        } catch (e) {
          lastErr = e;
          if (e.kind === 'bad_request' || e.kind === 'unsupported') throw e;
        }
      }
      throw lastErr;
    };
    return {
      async translate({ texts, source, target, signal }) {
        const out = new Array(texts.length);
        let detected = null;
        let requests = 0;
        for (const idxs of planGtxBatches(texts, 1800)) {
          if (idxs.length === 1) {
            const r = await call(texts[idxs[0]], source, target, signal);
            requests++;
            out[idxs[0]] = r.text.trim();
            detected ||= r.detected;
            continue;
          }
          const r = await call(idxs.map((i) => texts[i]).join('\n'), source, target, signal);
          requests++;
          detected ||= r.detected;
          const parts = splitJoined(r.text, idxs.length);
          if (parts) idxs.forEach((i, k) => { out[i] = parts[k]; });
          else {
            for (const i of idxs) {
              out[i] = (await call(texts[i], source, target, signal)).text.trim();
              requests++;
            }
          }
        }
        return { translations: out, detected, requests };
      },
    };
  },
};

// ----------------------------------------------------------------- LibreTranslate

const LIBRE_CANDIDATES = {
  'zh-CN': ['zh-Hans', 'zh', 'zh-CN'],
  'zh-TW': ['zh-Hant', 'zt', 'zh-TW'],
  he: ['he', 'iw'],
  tl: ['tl', 'fil'],
  no: ['nb', 'no'],
  pt: ['pt', 'pt-BR'],
};
const LIBRE_BACK = { 'zh-Hans': 'zh-CN', zh: 'zh-CN', 'zh-Hant': 'zh-TW', zt: 'zh-TW', nb: 'no', fil: 'tl', 'pt-BR': 'pt', iw: 'he' };

export const libreTranslate = {
  type: 'libretranslate',
  label: 'LibreTranslate (open source, self-hostable)',
  category: 'selfhost',
  signup: 'None when self-hosted; API key for libretranslate.com',
  serverSide: true,
  docs: 'https://docs.libretranslate.com',
  description: 'Open-source machine translation (Argos Translate models). Run it yourself for unlimited, private, offline translation.',
  notes: [
    'Self-hosted: free and unlimited. The bundled docker-compose has a ready "libre" profile: docker compose --profile libre up -d, then set the URL to http://libretranslate:5000.',
    'Needs roughly 2–4 GB RAM and downloads language models on first start (limit them with LT_LOAD_ONLY=en,es,fr…).',
    'The public libretranslate.com instance requires a paid API key. Some community mirrors are free but rate-limited.',
    'Quality is good for major European pairs and below Google/DeepL for others.',
  ],
  limits: { label: 'Unlimited when self-hosted' },
  fields: [
    { key: 'url', label: 'Server URL', type: 'url', required: true, placeholder: 'http://libretranslate:5000' },
    { key: 'apiKey', label: 'API key (if the server requires one)', type: 'password' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '30000' },
  ],
  batch: { maxItems: 50, maxChars: 8000 },
  concurrency: 2,
  create(cfg) {
    const base = trimSlash(cfg.url);
    let langs = null;
    let langsAt = 0;
    const available = async (signal) => {
      if (langs && Date.now() - langsAt < 3600_000) return langs;
      try {
        const res = await http(`${base}/languages`, { timeout: 8000, signal });
        const data = await jsonOrThrow(res, 'LibreTranslate');
        langs = new Set(data.map((l) => l.code));
      } catch {
        langs = null;
      }
      langsAt = Date.now();
      return langs;
    };
    const map = (code, set) => {
      const cands = LIBRE_CANDIDATES[code] || [code, code.split('-')[0]];
      if (!set) return cands[0];
      return cands.find((c) => set.has(c)) || cands[0];
    };
    return {
      async translate({ texts, source, target, signal }) {
        if (!base) throw new EngineError('config', 'LibreTranslate URL not configured');
        const set = await available(signal);
        const body = { q: texts, source: source === 'auto' ? 'auto' : map(source, set), target: map(target, set), format: 'text' };
        if (cfg.apiKey) body.api_key = cfg.apiKey;
        const res = await http(`${base}/translate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          timeout: Number(cfg.timeout) || 30000, signal,
        });
        const data = await jsonOrThrow(res, 'LibreTranslate');
        let tr = data.translatedText;
        if (typeof tr === 'string' && texts.length === 1) tr = [tr];
        if (!Array.isArray(tr) || tr.length !== texts.length) throw new EngineError('bad_response', data.error || 'LibreTranslate returned an unexpected answer');
        const det = Array.isArray(data.detectedLanguage) ? data.detectedLanguage : data.detectedLanguage ? [data.detectedLanguage] : [];
        return {
          translations: tr.map(String),
          detected: det.map((d) => (d?.language ? LIBRE_BACK[d.language] || d.language : null)),
        };
      },
    };
  },
};
