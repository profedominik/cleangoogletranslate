import { buildGtxUrl, parseGtx, planGtxBatches, splitJoined, GTX_ENDPOINT } from '../../public/shared/gtx.js';
import { EngineError, http, errorFromResponse, jsonOrThrow, BROWSER_UA, decodeEntities } from './base.js';

async function gtxRequest(text, source, target, cfg, signal) {
  const res = await http(buildGtxUrl(text, source, target, cfg.endpoint || GTX_ENDPOINT), {
    headers: { 'User-Agent': cfg.userAgent || BROWSER_UA, Accept: '*/*' },
    redirect: 'manual',
    timeout: Number(cfg.timeout) || 15000,
    signal,
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    throw new EngineError('rate_limit', /sorry/i.test(loc)
      ? 'Google answered with a captcha (HTTP 302 → google.com/sorry): this server IP is temporarily blocked'
      : `Google redirected unexpectedly (HTTP ${res.status})`, { status: res.status });
  }
  if (!res.ok) throw await errorFromResponse(res, 'Google');
  let data;
  try {
    data = await res.json();
  } catch {
    throw new EngineError('bad_response', 'Google returned a non-JSON answer');
  }
  return parseGtx(data);
}

export const googleFree = {
  type: 'google-free',
  label: 'Google Translate (free web endpoint)',
  category: 'free',
  signup: 'None',
  serverSide: true,
  docs: 'https://translate.google.com',
  description: 'The same free endpoint Google uses in its browser extensions (translate.googleapis.com, client=gtx). Best language coverage (130+), Google quality.',
  notes: [
    'Free, no account or API key needed.',
    'Unofficial: Google can change or close it without notice.',
    'Rate-limited per IP address with no published quota. Datacenter / VPS IPs are often challenged with a captcha (HTTP 302 → google.com/sorry) after bursts; the block usually lifts after minutes to hours.',
    'CleanTranslate batches lines, caches every result and puts the engine in a cool-down when blocked, so the auto chain falls through to the next engine.',
    'Tip: enable "Google (direct from your browser)" so translations come from the visitor\'s own IP, or point the endpoint at your own relay/proxy.',
    'For guaranteed volume use the official Google Cloud Translation engine (needs a Google Cloud account with billing).',
  ],
  limits: { label: 'No published limit (captcha when abused)' },
  fields: [
    { key: 'endpoint', label: 'Endpoint', type: 'url', placeholder: GTX_ENDPOINT, help: 'Override to route through your own relay or proxy.' },
    { key: 'userAgent', label: 'User-Agent', type: 'text', placeholder: 'Browser default' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '15000' },
  ],
  // GET requests: keep single items short enough that a percent-encoded URL stays small.
  batch: { maxItems: 100, maxChars: 4500, maxItemChars: 1000 },
  concurrency: 1,
  minInterval: 250,
  create(cfg) {
    return {
      async translate({ texts, source, target, signal }) {
        const out = new Array(texts.length);
        let detected = null;
        let requests = 0;
        for (const idxs of planGtxBatches(texts)) {
          if (idxs.length === 1) {
            const r = await gtxRequest(texts[idxs[0]], source, target, cfg, signal);
            requests++;
            out[idxs[0]] = r.text.trim();
            detected ||= r.detected;
            continue;
          }
          const r = await gtxRequest(idxs.map((i) => texts[i]).join('\n'), source, target, cfg, signal);
          requests++;
          detected ||= r.detected;
          const parts = splitJoined(r.text, idxs.length);
          if (parts) {
            idxs.forEach((i, k) => { out[i] = parts[k]; });
          } else {
            for (const i of idxs) {
              const r1 = await gtxRequest(texts[i], source, target, cfg, signal);
              requests++;
              out[i] = r1.text.trim();
            }
          }
        }
        return { translations: out, detected, requests };
      },
    };
  },
};

export const googleBrowser = {
  type: 'google-browser',
  label: 'Google Translate (direct from the visitor\'s browser)',
  category: 'free',
  signup: 'None',
  serverSide: false,
  docs: 'https://translate.google.com',
  description: 'The editor calls Google\'s free endpoint directly from the browser (it allows cross-origin requests), so requests come from the user\'s own IP instead of the server. Results are stored in the server cache.',
  notes: [
    'Free, no account. Same quality and language coverage as Google Translate.',
    'Avoids the captcha blocks that hit shared VPS / datacenter IPs, because each visitor uses their own connection.',
    'Only available inside the editor (not to API clients). The browser must be able to reach translate.googleapis.com.',
    'Also used automatically as a fallback when all server engines are blocked (Settings → "Browser fallback").',
  ],
  limits: { label: 'Per visitor IP, no published limit' },
  fields: [],
  batch: { maxItems: 100, maxChars: 4500 },
  create() {
    return {
      async translate() {
        throw new EngineError('config', 'This engine runs in the browser only');
      },
    };
  },
};

export const googleCloud = {
  type: 'google-cloud',
  label: 'Google Cloud Translation (official API)',
  category: 'key',
  signup: 'Google Cloud account + billing enabled',
  serverSide: true,
  docs: 'https://cloud.google.com/translate/docs/basic/translating-text',
  description: 'Official Google Cloud Translation API (Basic / v2) with an API key.',
  notes: [
    'Requires a Google Cloud project with billing enabled, the "Cloud Translation API" enabled and an API key (APIs & Services → Credentials).',
    'Free tier: the first 500,000 characters per month are free; after that it is billed per million characters (see the pricing page).',
    'Restrict the key to the Cloud Translation API and, if possible, to your server IP.',
  ],
  limits: { perMonth: 500000, label: '500,000 chars / month free, then paid' },
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true },
    { key: 'endpoint', label: 'Endpoint', type: 'url', placeholder: 'https://translation.googleapis.com/language/translate/v2' },
  ],
  batch: { maxItems: 100, maxChars: 5000 },
  concurrency: 4,
  create(cfg) {
    return {
      async translate({ texts, source, target, signal }) {
        const body = { q: texts, target, format: 'text' };
        if (source && source !== 'auto') body.source = source;
        const url = `${cfg.endpoint || 'https://translation.googleapis.com/language/translate/v2'}?key=${encodeURIComponent(cfg.apiKey || '')}`;
        const res = await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        const data = await jsonOrThrow(res, 'Google Cloud');
        const tr = data?.data?.translations;
        if (!Array.isArray(tr) || tr.length !== texts.length) throw new EngineError('bad_response', 'Google Cloud returned an unexpected answer');
        return {
          translations: tr.map((t) => decodeEntities(t.translatedText ?? '')),
          detected: tr.map((t) => t.detectedSourceLanguage || null),
        };
      },
    };
  },
};
