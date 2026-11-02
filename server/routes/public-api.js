// Public "middleman" translation API (+ LibreTranslate-compatible endpoints).
// Other apps, dashboards or another CleanTranslate instance can call these.
import { LANGUAGES } from '../../public/shared/languages.js';
import { HttpError, readJson } from '../http.js';

function requestParams(query, body) {
  const get = (k) => (body && body[k] !== undefined ? body[k] : query.get(k) ?? undefined);
  let q = get('q');
  if (q === undefined && query.getAll('q').length > 1) q = query.getAll('q');
  return {
    q,
    source: get('source') ?? get('sl') ?? 'auto',
    target: get('target') ?? get('tl'),
    engine: get('engine') ?? 'auto',
    markup: get('markup') === true || get('markup') === 'true' || get('markup') === '1',
    key: get('api_key') ?? get('key'),
  };
}

export function registerPublicApi(router, { translator, settings }) {
  const guard = (req, key) => {
    const s = settings();
    if (!s.apiEnabled) throw new HttpError(403, 'The public translation API is disabled on this server');
    if (!s.apiKey) return;
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers['x-api-key'] || key;
    if (given !== s.apiKey) throw new HttpError(401, 'Missing or invalid API key (send "Authorization: Bearer <key>")');
  };

  const run = async (p) => {
    if (p.q == null || p.q === '') throw new HttpError(400, 'Missing "q"');
    const single = !Array.isArray(p.q);
    const texts = (single ? [p.q] : p.q).map((t) => String(t ?? ''));
    if (texts.length > 1000) throw new HttpError(413, 'At most 1000 texts per request');
    const r = await translator.translate({ texts, source: p.source, target: p.target, engine: p.engine, markup: p.markup });
    return { single, r };
  };

  // ---------------------------------------------------------------- v1
  const v1 = async ({ req, query, method }) => {
    const body = method === 'POST' ? await readJson(req, 1024 * 1024) : null;
    const p = requestParams(query, body);
    guard(req, p.key);
    const { single, r } = await run(p);
    const translations = r.results.map((x) => ({
      text: x.text,
      detectedSourceLanguage: x.detected || null,
      engine: x.engine || null,
      cached: !!x.cached,
      ...(x.error ? { error: x.error } : {}),
    }));
    const out = { translations, detectedSourceLanguage: r.detected, source: r.source, target: r.target };
    if (single) out.translatedText = translations[0].text;
    if (r.errors.length) out.errors = r.errors;
    if (translations.every((t) => t.text == null)) {
      throw new HttpError(502, r.errors[r.errors.length - 1]?.message || 'Translation failed', { errors: r.errors });
    }
    return out;
  };
  router.post('/api/v1/translate', v1);
  router.get('/api/v1/translate', v1);

  router.get('/api/v1/engines', ({ req, query }) => {
    guard(req, query.get('key'));
    return {
      auto: translator.autoChain().map((r) => r.id),
      engines: translator.publicEngines().filter((e) => e.serverSide),
    };
  });

  router.get('/api/v1/languages', () => ({ languages: LANGUAGES }));

  // ---------------------------------------------------------------- LibreTranslate compatible
  router.post('/api/libre/translate', async ({ req, query }) => {
    const body = await readJson(req, 1024 * 1024);
    const p = requestParams(query, body);
    guard(req, p.key);
    const { single, r } = await run(p);
    const failed = r.results.find((x) => x.text == null);
    if (failed) throw new HttpError(500, failed.error || 'Translation failed');
    const texts = r.results.map((x) => x.text);
    const out = { translatedText: single ? texts[0] : texts };
    if (r.source === 'auto') {
      const det = { confidence: r.detected ? 90 : 0, language: r.detected || 'en' };
      out.detectedLanguage = single ? det : texts.map(() => det);
    }
    return out;
  });

  router.get('/api/libre/languages', () => {
    const codes = LANGUAGES.map((l) => l.code);
    return LANGUAGES.map((l) => ({ code: l.code, name: l.name, targets: codes }));
  });

  router.post('/api/libre/detect', async ({ req, query }) => {
    const body = await readJson(req);
    const p = requestParams(query, body);
    guard(req, p.key);
    const r = await translator.translate({ texts: [String(p.q || '').slice(0, 500)], source: 'auto', target: 'en' });
    return [{ confidence: r.detected ? 90 : 0, language: r.detected || 'en' }];
  });

  router.get('/api/libre/frontend/settings', () => ({
    apiKeys: !!settings().apiKey, keyRequired: !!settings().apiKey, charLimit: -1, suggestions: false, supportedFilesFormat: [],
    language: { source: { code: 'auto', name: 'Auto Detect' }, target: { code: settings().defaultTarget, name: settings().defaultTarget } },
  }));
}
