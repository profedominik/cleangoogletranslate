import { EngineError, http, jsonOrThrow, errorFromResponse, BROWSER_UA, trimSlash } from './base.js';

// Our (Google-style) codes -> Microsoft Translator codes.
const TO_MS = {
  'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', tl: 'fil', no: 'nb', ku: 'kmr', ckb: 'ku',
  'mni-Mtei': 'mni', sr: 'sr-Cyrl', mn: 'mn-Cyrl', he: 'he', jv: 'jv',
};
const FROM_MS = {
  'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', fil: 'tl', nb: 'no', kmr: 'ku', ku: 'ckb', mni: 'mni-Mtei',
  'sr-Cyrl': 'sr', 'sr-Latn': 'sr', 'mn-Cyrl': 'mn', 'pt-PT': 'pt', 'fr-CA': 'fr', 'zh-yue': 'zh-TW', lzh: 'zh-TW',
};
export const toMs = (c) => TO_MS[c] || c;
export const fromMs = (c) => (c ? FROM_MS[c] || c : null);

async function msTranslate({ base, headers, texts, source, target, signal }) {
  const params = new URLSearchParams({ 'api-version': '3.0', to: toMs(target) });
  if (source && source !== 'auto') params.set('from', toMs(source));
  const res = await http(`${base}/translate?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(texts.map((Text) => ({ Text }))),
    signal,
  });
  return res;
}

function parseMs(data, n, label) {
  if (!Array.isArray(data) || data.length !== n) throw new EngineError('bad_response', `${label} returned an unexpected answer`);
  return {
    translations: data.map((d) => d?.translations?.[0]?.text ?? ''),
    detected: data.map((d) => fromMs(d?.detectedLanguage?.language)),
  };
}

// ----------------------------------------------------------------- Edge (free)

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export const edgeFree = {
  type: 'edge-free',
  label: 'Microsoft Edge Translator (free)',
  category: 'free',
  signup: 'None',
  serverSide: true,
  docs: 'https://www.microsoft.com/translator',
  description: 'Uses the free token that Microsoft Edge\'s built-in page translator gets from edge.microsoft.com, then calls Microsoft Translator. Good quality, 100+ languages, batches many lines per request.',
  notes: [
    'Free, no account or API key needed.',
    'Unofficial: relies on the token endpoint built into the Edge browser (edge.microsoft.com/translate/auth); Microsoft may change or restrict it at any time.',
    'Rate limits are not published; it is generally more tolerant of server IPs than the free Google endpoint, which makes it a good second engine in the auto chain.',
    'For an official, documented quota use the "Microsoft Azure Translator" engine (free tier available with an Azure account).',
  ],
  limits: { label: 'No published limit' },
  fields: [
    { key: 'authUrl', label: 'Token URL', type: 'url', placeholder: 'https://edge.microsoft.com/translate/auth' },
    { key: 'endpoint', label: 'Translator endpoint', type: 'url', placeholder: 'https://api-edge.cognitive.microsofttranslator.com' },
  ],
  batch: { maxItems: 100, maxChars: 10000 },
  concurrency: 2,
  minInterval: 100,
  create(cfg) {
    let token = null;
    let exp = 0;
    const getToken = async (signal, force = false) => {
      if (!force && token && Date.now() < exp - 60_000) return token;
      const res = await http(cfg.authUrl || 'https://edge.microsoft.com/translate/auth', {
        headers: { 'User-Agent': `${BROWSER_UA} Edg/131.0.0.0` },
        timeout: 10000,
        signal,
      });
      if (!res.ok) throw await errorFromResponse(res, 'Edge token');
      const t = (await res.text()).trim();
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) throw new EngineError('bad_response', 'Edge token endpoint returned an unexpected answer');
      token = t;
      exp = jwtExp(t) || Date.now() + 8 * 60_000;
      return token;
    };
    return {
      async translate({ texts, source, target, signal }) {
        const base = trimSlash(cfg.endpoint) || 'https://api-edge.cognitive.microsofttranslator.com';
        let res = await msTranslate({ base, headers: { Authorization: `Bearer ${await getToken(signal)}` }, texts, source, target, signal });
        if (res.status === 401) {
          res = await msTranslate({ base, headers: { Authorization: `Bearer ${await getToken(signal, true)}` }, texts, source, target, signal });
        }
        return parseMs(await jsonOrThrow(res, 'Microsoft (Edge)'), texts.length, 'Microsoft (Edge)');
      },
    };
  },
};

// ----------------------------------------------------------------- Azure (official)

export const azure = {
  type: 'azure',
  label: 'Microsoft Azure AI Translator (official API)',
  category: 'key',
  signup: 'Azure account (free tier F0 available)',
  serverSide: true,
  docs: 'https://learn.microsoft.com/azure/ai-services/translator/',
  description: 'Official Microsoft Translator Text API v3 with a subscription key.',
  notes: [
    'Requires an Azure account and a "Translator" resource (Azure portal → Create resource → Translator). Copy Key 1 and the Location/Region.',
    'Free tier F0: 2 million characters per month at no cost. Paid tiers are billed per million characters.',
    'The region is required for regional and multi-service resources (e.g. "westeurope"); leave it empty only for global resources.',
  ],
  limits: { perMonth: 2000000, label: '2,000,000 chars / month on the free F0 tier' },
  fields: [
    { key: 'apiKey', label: 'Subscription key', type: 'password', required: true },
    { key: 'region', label: 'Region', type: 'text', placeholder: 'westeurope' },
    { key: 'endpoint', label: 'Endpoint', type: 'url', placeholder: 'https://api.cognitive.microsofttranslator.com' },
  ],
  batch: { maxItems: 100, maxChars: 40000 },
  concurrency: 4,
  create(cfg) {
    return {
      async translate({ texts, source, target, signal }) {
        const headers = { 'Ocp-Apim-Subscription-Key': cfg.apiKey || '' };
        if (cfg.region) headers['Ocp-Apim-Subscription-Region'] = cfg.region;
        const base = trimSlash(cfg.endpoint) || 'https://api.cognitive.microsofttranslator.com';
        const res = await msTranslate({ base, headers, texts, source, target, signal });
        return parseMs(await jsonOrThrow(res, 'Azure Translator'), texts.length, 'Azure Translator');
      },
    };
  },
};
