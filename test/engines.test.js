import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_TYPES } from '../server/engines/index.js';
import { getPath, renderTemplate } from '../server/engines/custom.js';
import { splitText } from '../server/engines/base.js';
import { deeplTarget } from '../server/engines/deepl.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Install a fetch mock. `handler(url, init, n)` returns { status, body, headers }. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init, body: init.body });
    const r = await handler(u, init, calls.length);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return new Response(r.status === 302 ? null : body, { status: r.status || 200, headers: r.headers || { 'content-type': 'application/json' } });
  };
  return calls;
}

const make = (type, cfg = {}) => ENGINE_TYPES[type].create(cfg);

test('google-free: batches lines with newlines and splits the answer', async () => {
  const calls = mockFetch((url) => {
    const q = new URL(url).searchParams.get('q');
    const out = q.split('\n').map((l) => `ES(${l})`).join('\n');
    return { body: [[[out, q, null, null, 1]], null, 'en'] };
  });
  const r = await make('google-free').translate({ texts: ['Hello', 'World', 'Third line'], source: 'auto', target: 'es' });
  assert.deepEqual(r.translations, ['ES(Hello)', 'ES(World)', 'ES(Third line)']);
  assert.equal(r.detected, 'en');
  assert.equal(calls.length, 1, 'one request for the whole batch');
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('client'), 'gtx');
  assert.equal(u.searchParams.get('sl'), 'auto');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('google-free: falls back to one request per line when the line count changes', async () => {
  const calls = mockFetch((url) => {
    const q = new URL(url).searchParams.get('q');
    return { body: [[[q.replace(/\n/g, ' '), q]], null, 'en'] };
  });
  const r = await make('google-free').translate({ texts: ['a b', 'c d'], source: 'en', target: 'de' });
  assert.deepEqual(r.translations, ['a b', 'c d']);
  assert.equal(calls.length, 3);
});

test('google-free: captcha redirect is a rate limit', async () => {
  mockFetch(() => ({ status: 302, headers: { location: 'https://www.google.com/sorry/index?continue=x' } }));
  await assert.rejects(make('google-free').translate({ texts: ['x'], source: 'en', target: 'es' }), (e) => e.kind === 'rate_limit');
  mockFetch(() => ({ status: 429, body: 'Too many' }));
  await assert.rejects(make('google-free').translate({ texts: ['x'], source: 'en', target: 'es' }), (e) => e.kind === 'rate_limit');
});

test('google-cloud: request and response format', async () => {
  const calls = mockFetch(() => ({ body: { data: { translations: [{ translatedText: 'Hola &amp; adiós', detectedSourceLanguage: 'en' }] } } }));
  const r = await make('google-cloud', { apiKey: 'KEY' }).translate({ texts: ['Hello & bye'], source: 'auto', target: 'es' });
  assert.deepEqual(r.translations, ['Hola & adiós']);
  assert.match(calls[0].url, /key=KEY/);
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body, { q: ['Hello & bye'], target: 'es', format: 'text' });
});

test('edge-free: fetches a token, refreshes it on 401, maps language codes', async () => {
  const token = (exp) => `aaa.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.ccc`;
  let translateCalls = 0;
  const calls = mockFetch((url) => {
    if (url.includes('/translate/auth')) return { body: token(Math.floor(Date.now() / 1000) + 600), headers: { 'content-type': 'text/plain' } };
    translateCalls++;
    if (translateCalls === 1) return { status: 401, body: { error: { code: 401000, message: 'expired' } } };
    return { body: [{ detectedLanguage: { language: 'zh-Hans', score: 1 }, translations: [{ text: 'Hola', to: 'es' }] }] };
  });
  const r = await make('edge-free').translate({ texts: ['你好'], source: 'auto', target: 'es' });
  assert.deepEqual(r.translations, ['Hola']);
  assert.deepEqual(r.detected, ['zh-CN']);
  const tr = calls.filter((c) => c.url.includes('/translate?'));
  assert.equal(tr.length, 2);
  assert.match(tr[1].init.headers.Authorization, /^Bearer aaa\./);
  assert.equal(new URL(tr[0].url).searchParams.get('from'), null, 'auto -> no from param');
  assert.equal(calls.filter((c) => c.url.includes('/auth')).length, 2, 'token refreshed after 401');
  const r2 = await make('edge-free').translate({ texts: ['x'], source: 'zh-TW', target: 'tl' }).catch(() => null);
  assert.ok(r2);
  const last = calls[calls.length - 1];
  assert.equal(new URL(last.url).searchParams.get('from'), 'zh-Hant');
  assert.equal(new URL(last.url).searchParams.get('to'), 'fil');
});

test('azure: subscription headers and region', async () => {
  const calls = mockFetch(() => ({ body: [{ translations: [{ text: 'Bonjour' }] }] }));
  const r = await make('azure', { apiKey: 'K', region: 'westeurope' }).translate({ texts: ['Hello'], source: 'en', target: 'fr' });
  assert.deepEqual(r.translations, ['Bonjour']);
  assert.equal(calls[0].init.headers['Ocp-Apim-Subscription-Key'], 'K');
  assert.equal(calls[0].init.headers['Ocp-Apim-Subscription-Region'], 'westeurope');
  assert.deepEqual(JSON.parse(calls[0].body), [{ Text: 'Hello' }]);
});

test('mymemory: one request per piece, email param, quota detection, entity decoding', async () => {
  const calls = mockFetch((url) => {
    const q = new URL(url).searchParams.get('q');
    return { body: { responseData: { translatedText: `T:${q}&#39;` }, responseStatus: 200 } };
  });
  const long = 'Sentence one is here. '.repeat(40).trim();
  const r = await make('mymemory', { email: 'me@example.com' }).translate({ texts: ['Hi', long], source: 'en', target: 'it' });
  assert.equal(r.translations[0], "T:Hi'");
  assert.ok(calls.length > 2, 'long text split into several requests');
  for (const c of calls) assert.ok(Buffer.byteLength(new URL(c.url).searchParams.get('q')) <= 500);
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('langpair'), 'en|it');
  assert.equal(u.searchParams.get('de'), 'me@example.com');
  mockFetch(() => ({ body: { responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }, responseStatus: 429, quotaFinished: true } }));
  await assert.rejects(make('mymemory').translate({ texts: ['x'], source: 'en', target: 'it' }), (e) => e.kind === 'quota');
});

test('lingva: tries instances in order and maps codes', async () => {
  const calls = mockFetch((url) => {
    if (url.startsWith('https://dead.example')) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return { body: { translation: 'Ciao', info: { detectedSource: 'en' } } };
  });
  const r = await make('lingva', { instances: 'https://dead.example\nhttps://ok.example/' }).translate({ texts: ['Hello'], source: 'auto', target: 'zh-TW' });
  assert.deepEqual(r.translations, ['Ciao']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://ok.example/api/v1/auto/zh_HANT/Hello');
});

test('libretranslate: array q, language discovery, detected languages', async () => {
  const calls = mockFetch((url, init) => {
    if (url.endsWith('/languages')) return { body: [{ code: 'en' }, { code: 'zh-Hans' }, { code: 'es' }] };
    const body = JSON.parse(init.body);
    return { body: { translatedText: body.q.map((q) => `L(${q})`), detectedLanguage: body.q.map(() => ({ language: 'en', confidence: 90 })) } };
  });
  const r = await make('libretranslate', { url: 'http://lt:5000/', apiKey: 'abc' }).translate({ texts: ['a', 'b'], source: 'auto', target: 'zh-CN' });
  assert.deepEqual(r.translations, ['L(a)', 'L(b)']);
  assert.deepEqual(r.detected, ['en', 'en']);
  const body = JSON.parse(calls[1].body);
  assert.equal(body.target, 'zh-Hans');
  assert.equal(body.api_key, 'abc');
  assert.equal(calls[1].url, 'http://lt:5000/translate');
});

test('deepl: free host for :fx keys, target variants, quota error', async () => {
  const calls = mockFetch(() => ({ body: { translations: [{ detected_source_language: 'DE', text: 'Hello' }] } }));
  const r = await make('deepl', { apiKey: 'abc:fx', englishVariant: 'EN-GB' }).translate({ texts: ['Hallo'], source: 'auto', target: 'en' });
  assert.deepEqual(r.translations, ['Hello']);
  assert.deepEqual(r.detected, ['de']);
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[0].init.headers.Authorization, 'DeepL-Auth-Key abc:fx');
  assert.deepEqual(JSON.parse(calls[0].body), { text: ['Hallo'], target_lang: 'EN-GB' });
  assert.equal(deeplTarget('zh-TW'), 'ZH-HANT');
  assert.equal(deeplTarget('pt'), 'PT-BR');
  mockFetch(() => ({ status: 456, body: { message: 'Quota exceeded' } }));
  await assert.rejects(make('deepl', { apiKey: 'pro' }).translate({ texts: ['x'], source: 'de', target: 'fr' }), (e) => e.kind === 'quota');
  await assert.rejects(make('deepl', { apiKey: 'k' }).translate({ texts: ['x'], source: 'en', target: 'sw' }), (e) => e.kind === 'unsupported');
});

test('custom engine: templates, batch and single modes, response paths', async () => {
  const calls = mockFetch((url, init) => {
    const b = JSON.parse(init.body);
    if (Array.isArray(b.q)) return { body: { data: { items: b.q.map((q) => ({ out: q.toUpperCase() })) } } };
    return { body: { data: `${b.text}!` } };
  });
  const batch = make('custom', { url: 'http://x/api', mode: 'batch', body: '{"q": {{texts}}, "to": "{{TARGET}}"}', responsePath: 'data.items[].out' });
  assert.deepEqual((await batch.translate({ texts: ['a', 'b'], source: 'auto', target: 'es' })).translations, ['A', 'B']);
  assert.equal(JSON.parse(calls[0].body).to, 'ES');
  const single = make('custom', { url: 'http://x/api', mode: 'single', body: '{"text": {{text}}, "s": "{{SOURCE_OR_EMPTY}}"}', responsePath: 'data' });
  assert.deepEqual((await single.translate({ texts: ['he said "hi"'], source: 'auto', target: 'es' })).translations, ['he said "hi"!']);
  assert.equal(JSON.parse(calls[1].body).s, '');
  const wrong = make('custom', { url: 'http://x/api', mode: 'batch', body: '{"q": {{texts}}}', responsePath: 'nope' });
  await assert.rejects(wrong.translate({ texts: ['a'], source: 'en', target: 'es' }), (e) => e.kind === 'bad_response');
  assert.deepEqual(getPath({ a: [{ b: 1 }, { b: 2 }] }, 'a[].b'), [1, 2]);
  assert.equal(getPath([{ t: [{ x: 'y' }] }], '[0].t[0].x'), 'y');
  assert.equal(renderTemplate('{{ a }}-{{b}}-{{c}}', { a: 1, b: 2 }), '1-2-{{c}}');
});

test('middleman: forwards to /api/v1/translate with bearer key', async () => {
  const calls = mockFetch(() => ({ body: { translations: [{ text: 'Hallo', detectedSourceLanguage: 'en' }] } }));
  const r = await make('middleman', { url: 'https://hub.example.com/', apiKey: 'K', remoteEngine: 'deepl' }).translate({ texts: ['Hello'], source: 'auto', target: 'de' });
  assert.deepEqual(r.translations, ['Hallo']);
  assert.equal(calls[0].url, 'https://hub.example.com/api/v1/translate');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer K');
  assert.equal(JSON.parse(calls[0].body).engine, 'deepl');
});

test('splitText keeps pieces under the limit and preserves words', () => {
  const text = 'Short one. ' + 'A much longer sentence that keeps on going and going. '.repeat(10) + 'x'.repeat(130);
  const pieces = splitText(text, 120);
  assert.ok(pieces.every((p) => p.length <= 120));
  assert.equal(pieces.join(' ').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.deepEqual(splitText('tiny', 10), ['tiny']);
});

test('every engine type declares the metadata the admin UI needs', () => {
  for (const def of Object.values(ENGINE_TYPES)) {
    assert.ok(def.label && def.description, def.type);
    assert.ok(Array.isArray(def.notes) && def.notes.length, `${def.type} notes`);
    assert.ok(Array.isArray(def.fields), `${def.type} fields`);
    assert.ok(def.limits?.label, `${def.type} limits`);
    assert.equal(typeof def.create, 'function');
  }
});
