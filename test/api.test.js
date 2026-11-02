import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let t;
before(async () => { t = await startApp({ BASE_PATH: '/translate' }); });
after(async () => { await t.close(); });

test('health, config and templated pages under BASE_PATH', async () => {
  const h = await t.get('/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);
  const c = await t.get('/api/config');
  assert.equal(c.json.basePath, '/translate');
  assert.ok(c.json.tags.find((x) => x.name === 'NOTRANSLATE'));
  assert.ok(c.json.engines.find((x) => x.id === 'echo'));
  const page = await fetch(t.base + '/');
  const html = await page.text();
  assert.match(html, /<base href="\/translate\/">/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors/);
  const notePage = await fetch(t.base + '/n/abc123');
  assert.equal(notePage.status, 200);
  const admin = await fetch(t.base + '/admin');
  assert.equal(admin.status, 200);
  const missing = await t.get('/api/nope');
  assert.equal(missing.status, 404);
  const traversal = await fetch(t.base + '/assets/../../package.json');
  assert.notEqual(traversal.status, 200);
});

test('notes: create, list, save with versioning, conflict, patch, trash, restore', async () => {
  const created = await t.post('/api/notes', { title: 'Lesson 1', sourceLang: 'es', targetLang: 'en', lines: ['[DIALOG]', 'Ana: Hola', '[/DIALOG]'] });
  assert.equal(created.status, 200);
  const n = created.json;
  assert.equal(n.version, 1);
  assert.equal(n.lines.length, 3);
  assert.ok(n.lines.every((l) => l.id));

  const list = await t.get('/api/notes');
  assert.ok(list.json.notes.find((x) => x.id === n.id));
  const search = await t.get('/api/notes?q=Hola');
  assert.equal(search.json.notes.length, 1);

  const lines = [...n.lines, { id: 'x1', text: 'Nueva línea', tr: 'New line', trKey: 'k', trEngine: 'echo' }];
  const saved = await t.put(`/api/notes/${n.id}`, { baseVersion: 1, lines, title: 'Lesson 1b' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.version, 2);

  const stale = await t.put(`/api/notes/${n.id}`, { baseVersion: 1, lines });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current.version, 2);

  const forced = await t.put(`/api/notes/${n.id}`, { baseVersion: 1, lines, force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.version, 3);

  const got = await t.get(`/api/notes/${n.id}`);
  assert.equal(got.json.title, 'Lesson 1b');
  assert.equal(got.json.lines[3].tr, 'New line');
  assert.equal(got.json.translatedCount, 1);

  const patched = await t.patch(`/api/notes/${n.id}`, { targetLang: 'de', pinned: true });
  assert.equal(patched.json.targetLang, 'de');
  assert.equal(patched.json.pinned, true);
  assert.equal((await t.patch(`/api/notes/${n.id}`, { targetLang: 'xx' })).status, 400);

  const dup = await t.post(`/api/notes/${n.id}/duplicate`);
  assert.match(dup.json.title, /copy/);
  assert.equal(dup.json.lines.length, 4);

  assert.equal((await t.del(`/api/notes/${dup.json.id}`)).status, 200);
  assert.equal((await t.get(`/api/notes/${dup.json.id}`)).status, 404);
  const trash = await t.get('/api/admin/notes?trash=1');
  assert.ok(trash.json.notes.find((x) => x.id === dup.json.id));
  await t.post(`/api/admin/notes/${dup.json.id}/restore`);
  assert.equal((await t.get(`/api/notes/${dup.json.id}`)).status, 200);
});

test('notes: lines with newlines are split, ids deduplicated, beacon save alias', async () => {
  const c = await t.post('/api/notes', { lines: [{ id: 'same', text: 'a\nb' }, { id: 'same', text: 'c' }] });
  assert.deepEqual(c.json.lines.map((l) => l.text), ['a', 'b', 'c']);
  assert.equal(new Set(c.json.lines.map((l) => l.id)).size, 3);
  const s = await t.post(`/api/notes/${c.json.id}/save`, { lines: ['x'] });
  assert.equal(s.status, 200);
});

test('revisions: large deletions are snapshotted and can be restored', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const c = await t.post('/api/notes', { lines });
  const id = c.json.id;
  await t.put(`/api/notes/${id}`, { lines: ['only one line left'] });
  const revs = await t.get(`/api/notes/${id}/revisions`);
  const before = revs.json.revisions.find((r) => r.reason === 'before-large-delete');
  assert.ok(before, 'snapshot before large delete');
  assert.equal(before.lineCount, 20);
  const restored = await t.post(`/api/notes/${id}/revisions/${before.id}/restore`);
  assert.equal(restored.json.lines.length, 20);
  const one = await t.get(`/api/notes/${id}/revisions/${before.id}`);
  assert.equal(one.json.lines[5].text, 'line 5');
});

test('exports in every format', async () => {
  const c = await t.post('/api/notes', { title: 'Export me', sourceLang: 'es', targetLang: 'en', lines: [
    '[DIALOG]', { text: 'Ana: Hola', tr: 'Ana: Hello' }, '[/DIALOG]', '[NOTRANSLATE] Juan', '| a, "b" | c |',
  ] });
  const id = c.json.id;
  const txt = await t.get(`/api/notes/${id}/export?format=txt&side=translation`);
  assert.match(txt.headers.get('content-disposition'), /attachment/);
  assert.equal(txt.text, '[DIALOG]\nAna: Hello\n[/DIALOG]\n[NOTRANSLATE] Juan\n\n');
  const csv = await t.get(`/api/notes/${id}/export?format=csv&side=both`);
  const csvBytes = Buffer.from(await (await fetch(`${t.base}/api/notes/${id}/export?format=csv&side=both`)).arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  assert.ok(csv.text.startsWith('#,Spanish,English'));
  assert.match(csv.text, /"\| a, ""b"" \| c \|"/);
  const html = await t.get(`/api/notes/${id}/export?format=html&side=both&inline=1`);
  assert.match(html.text, /<table/);
  assert.match(html.text, /class="pill"/);
  assert.doesNotMatch(html.text, /<script/);
  const md = await t.get(`/api/notes/${id}/export?format=md&side=both`);
  assert.match(md.text, /\| 2 \| Ana: Hola \| Ana: Hello \|/);
  const json = await t.get(`/api/notes/${id}/export?format=json`);
  assert.equal(json.json.format, 'cleantranslate-note@1');
  const imp = await t.post('/api/notes/import', json.json);
  assert.equal(imp.json.lines.length, 5);
  const impTxt = await t.post('/api/notes/import', { text: 'one\ntwo', title: 'T' });
  assert.equal(impTxt.json.lines.length, 2);
});

test('translate: echo engine, markup protection, dedupe, cache', async () => {
  const body = { texts: ['Hello `amigo` {{x}}', 'Hello `amigo` {{x}}', '42', ' padded '], source: 'en', target: 'es' };
  const r1 = await t.post('/api/translate', body);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.results[0].text, 'HELLO `amigo` {{x}}');
  assert.equal(r1.json.results[1].text, 'HELLO `amigo` {{x}}');
  assert.equal(r1.json.results[2].skipped, true);
  assert.equal(r1.json.results[3].text, ' PADDED ');
  assert.equal(r1.json.results[0].cached, false);
  const r2 = await t.post('/api/translate', body);
  assert.equal(r2.json.results[0].cached, true);
  assert.equal(r2.json.results[0].engine, 'echo');
  const bad = await t.post('/api/translate', { texts: ['x'], target: 'nope' });
  assert.equal(bad.status, 400);
  const same = await t.post('/api/translate', { texts: ['Hola'], source: 'es', target: 'es' });
  assert.equal(same.json.results[0].text, 'Hola');
});

test('translate: auto chain falls through a rate-limited engine and cools it down', async () => {
  const add = await t.post('/api/admin/engines', { type: 'echo', name: 'Echo prefix', inAuto: true, config: { mode: 'prefix' } });
  assert.equal(add.status, 200);
  const failing = await t.put('/api/admin/engines/echo', { config: { mode: 'upper', fail: 'rate_limit' } });
  assert.equal(failing.status, 200);
  const r = await t.post('/api/translate', { texts: ['fresh text one'], source: 'en', target: 'fr' });
  assert.equal(r.json.results[0].text, '[fr] fresh text one');
  assert.equal(r.json.results[0].engine, add.json.id);
  assert.equal(r.json.errors[0].kind, 'rate_limit');
  const r2 = await t.post('/api/translate', { texts: ['fresh text two'], source: 'en', target: 'fr' });
  assert.equal(r2.json.errors[0].kind, 'cooldown');
  const eng = await t.get('/api/admin/engines');
  assert.equal(eng.json.engines.find((e) => e.id === 'echo').status.coolingDown, true);
  await t.post('/api/admin/engines/echo/reset');
  await t.put('/api/admin/engines/echo', { config: { mode: 'upper', fail: 'none' } });
  await t.del(`/api/admin/engines/${add.json.id}`);
  const logs = await t.get('/api/admin/logs?level=warn');
  assert.ok(logs.json.logs.some((l) => /Simulated rate limit/.test(l.message)));
});

test('browser engine: results are cached and served back, misses flagged', async () => {
  const miss = await t.post('/api/translate', { texts: ['Browser line'], source: 'en', target: 'it', engine: 'google-browser' });
  assert.equal(miss.json.results[0].miss, true);
  const st = await t.post('/api/translate/browser', { source: 'en', target: 'it', items: [{ text: 'Browser line', out: 'Riga del browser', detected: 'en' }], requests: 1 });
  assert.equal(st.json.stored, 1);
  const hit = await t.post('/api/translate', { texts: ['Browser line'], source: 'en', target: 'it', engine: 'google-browser' });
  assert.equal(hit.json.results[0].text, 'Riga del browser');
  assert.equal(hit.json.results[0].cached, true);
});

test('admin: engines config masking, custom engine validation, ordering, delete rules', async () => {
  const up = await t.put('/api/admin/engines/deepl', { enabled: true, config: { apiKey: 'secret-key-1234:fx' } });
  assert.equal(up.json.config.apiKey, '••••4:fx');
  // Saving the masked value keeps the real secret.
  const again = await t.put('/api/admin/engines/deepl', { config: { apiKey: up.json.config.apiKey, englishVariant: 'EN-GB' } });
  assert.equal(again.json.config.apiKey, '••••4:fx');
  assert.equal(t.app.store.getEngineRow('deepl').config.apiKey, 'secret-key-1234:fx');
  await t.put('/api/admin/engines/deepl', { enabled: false });
  assert.equal((await t.del('/api/admin/engines/google-free')).status, 400);
  const custom = await t.post('/api/admin/engines', { type: 'custom', name: 'My API', config: { url: 'ftp://nope', responsePath: 'x' } });
  const test1 = await t.post(`/api/admin/engines/${custom.json.id}/test`, {});
  assert.equal(test1.json.ok, false);
  assert.match(test1.json.error, /http/);
  const order = await t.post('/api/admin/engines/order', { ids: ['echo', 'google-free'] });
  assert.deepEqual(order.json.autoChain, ['echo']);
  const okTest = await t.post('/api/admin/engines/echo/test', { text: 'ping' });
  assert.equal(okTest.json.ok, true);
  assert.equal(okTest.json.text, 'PING');
  assert.equal((await t.post('/api/admin/engines', { type: 'nope' })).status, 400);
  await t.del(`/api/admin/engines/${custom.json.id}`);
});

test('admin: overview, usage, cache, settings validation, tags, system, backup, export/import', async () => {
  const ov = await t.get('/api/admin/overview');
  assert.ok(ov.json.stats.notes >= 1);
  assert.ok(Array.isArray(ov.json.usage));
  const usage = await t.get('/api/admin/usage?days=7');
  assert.ok(usage.json.usage.some((u) => u.engine === 'echo'));
  const cache = await t.get('/api/admin/cache?q=amigo');
  assert.ok(cache.json.entries.length >= 1);
  const bad = await t.put('/api/admin/settings', { autosaveDelayMs: 5 });
  assert.equal(bad.status, 400);
  const ok = await t.put('/api/admin/settings', { instanceName: 'Profe Translate', ui: { zebra: false } });
  assert.equal(ok.json.settings.instanceName, 'Profe Translate');
  assert.equal(ok.json.settings.ui.zebra, false);
  assert.equal(ok.json.settings.ui.lineNumbers, true);
  const page = await (await fetch(t.base + '/')).text();
  assert.match(page, /Profe Translate/);
  const tag = await t.post('/api/tags', { name: 'homework', color: '#ff0000', kind: 'section' });
  assert.ok(tag.json.tags.find((x) => x.name === 'HOMEWORK'));
  assert.equal((await t.post('/api/tags', { name: '1bad' })).status, 400);
  const sys = await t.get('/api/admin/system');
  assert.equal(sys.json.basePath, '/translate');
  const backup = await fetch(t.base + '/api/admin/backup');
  const buf = Buffer.from(await backup.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  const exp = await t.get('/api/admin/export');
  assert.equal(exp.json.format, 'cleantranslate-export@1');
  const before = (await t.get('/api/notes')).json.notes.length;
  const imp = await t.post('/api/admin/import', { notes: exp.json.notes.slice(0, 2) });
  assert.equal(imp.json.created, 2);
  assert.equal((await t.get('/api/notes')).json.notes.length, before + 2);
  const cleared = await t.del('/api/admin/cache');
  assert.ok(cleared.json.deleted >= 1);
});

test('public API v1: GET/POST, API key, CORS, libre-compatible endpoints', async () => {
  const pre = await fetch(t.base + '/api/v1/translate', { method: 'OPTIONS', headers: { Origin: 'https://dash.example.com' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const g = await t.get('/api/v1/translate?q=hello&target=de');
  assert.equal(g.json.translatedText, 'HELLO');
  const p = await t.post('/api/v1/translate', { q: ['a', 'b'], source: 'en', target: 'es' });
  assert.deepEqual(p.json.translations.map((x) => x.text), ['A', 'B']);
  await t.put('/api/admin/settings', { apiKey: 'k3y', apiCors: 'https://dash.example.com' });
  assert.equal((await t.post('/api/v1/translate', { q: 'x', target: 'es' })).status, 401);
  const withKey = await t.post('/api/v1/translate', { q: 'x', target: 'es' }, { Authorization: 'Bearer k3y', Origin: 'https://dash.example.com' });
  assert.equal(withKey.status, 200);
  assert.equal(withKey.headers.get('access-control-allow-origin'), 'https://dash.example.com');
  const bodyKey = await t.post('/api/libre/translate', { q: 'cat', source: 'auto', target: 'fr', api_key: 'k3y' });
  assert.equal(bodyKey.json.translatedText, 'CAT');
  assert.equal(bodyKey.json.detectedLanguage.language, 'en');
  const langs = await t.get('/api/libre/languages');
  assert.ok(langs.json.find((l) => l.code === 'es'));
  // the editor endpoint is not affected by the public API key
  assert.equal((await t.post('/api/translate', { texts: ['y'], target: 'es' })).status, 200);
  await t.put('/api/admin/settings', { apiKey: '', apiCors: '*', apiEnabled: false });
  assert.equal((await t.get('/api/v1/translate?q=x&target=es')).status, 403);
  await t.put('/api/admin/settings', { apiEnabled: true });
});

test('optional basic auth protects everything except health', async () => {
  const a = await startApp({ BASIC_AUTH: 'teacher:s3cret' });
  try {
    assert.equal((await a.get('/api/health')).status, 200);
    assert.equal((await a.get('/api/notes')).status, 401);
    const auth = { Authorization: 'Basic ' + Buffer.from('teacher:s3cret').toString('base64') };
    assert.equal((await a.get('/api/notes', auth)).status, 200);
    const wrong = { Authorization: 'Basic ' + Buffer.from('teacher:nope').toString('base64') };
    assert.equal((await a.get('/', wrong)).status, 401);
  } finally {
    await a.close();
  }
});

test('admin can be protected separately or disabled', async () => {
  const a = await startApp({ ADMIN_AUTH: 'admin:pw' });
  try {
    assert.equal((await a.get('/api/notes')).status, 200);
    assert.equal((await a.get('/api/admin/overview')).status, 401);
    assert.equal((await fetch(a.base + '/admin')).status, 401);
  } finally {
    await a.close();
  }
  const b = await startApp({ ADMIN_ENABLED: 'false' });
  try {
    assert.equal((await b.get('/api/admin/overview')).status, 404);
  } finally {
    await b.close();
  }
});

test('public API refuses the browser-only engine with a clear message', async () => {
  const r = await t.post('/api/v1/translate', { q: 'hello', target: 'es', engine: 'google-browser' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /browser/);
});

test('editor translate endpoint is rate limited per IP', async () => {
  const prev = process.env.EDITOR_RATE_LIMIT;
  process.env.EDITOR_RATE_LIMIT = '3';
  const a = await startApp();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await a.post('/api/translate', { texts: [`x${i}`], target: 'es' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    if (prev === undefined) delete process.env.EDITOR_RATE_LIMIT;
    else process.env.EDITOR_RATE_LIMIT = prev;
    await a.close();
  }
});
