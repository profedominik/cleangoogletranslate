import { buildTagMap, normalizeTag } from '../../public/shared/markup.js';
import { LANGUAGES } from '../../public/shared/languages.js';
import { HttpError, readJson, sendText } from '../http.js';
import { renderExport, contentDisposition } from '../export.js';

const NOTE_BODY_LIMIT = 8 * 1024 * 1024;

export function registerNoteRoutes(router, { notes, settings, settingsSvc, translator, config }) {
  router.get('/api/config', () => {
    const s = settings();
    return {
      version: config.version,
      instanceName: s.instanceName,
      basePath: config.basePath,
      tags: s.tags,
      engines: translator.publicEngines(),
      defaults: { source: s.defaultSource, target: s.defaultTarget, engine: s.defaultEngine },
      ui: s.ui,
      autosaveDelayMs: s.autosaveDelayMs,
      translateDelayMs: s.translateDelayMs,
      browserFallback: s.browserFallback,
      adminEnabled: config.adminEnabled,
      testMode: config.testMode,
    };
  });

  router.get('/api/languages', () => ({ languages: LANGUAGES }));

  router.get('/api/notes', ({ query }) => ({
    notes: notes.list({
      q: String(query.get('q') || '').slice(0, 200),
      limit: Math.min(Number(query.get('limit')) || 200, 1000),
      offset: Math.max(Number(query.get('offset')) || 0, 0),
    }),
  }));

  router.post('/api/notes', async ({ req }) => notes.create(await readJson(req, NOTE_BODY_LIMIT)));

  router.post('/api/notes/import', async ({ req }) => {
    const body = await readJson(req, NOTE_BODY_LIMIT);
    const src = body.format === 'cleantranslate-note@1' || Array.isArray(body.lines) ? body : null;
    if (src) {
      return notes.create({ title: src.title, sourceLang: src.sourceLang, targetLang: src.targetLang, engine: src.engine, lines: src.lines });
    }
    if (typeof body.text !== 'string') throw new HttpError(400, 'Send { text } or a CleanTranslate note JSON');
    return notes.create({ title: body.title, sourceLang: body.sourceLang, targetLang: body.targetLang, lines: body.text });
  });

  router.get('/api/notes/:id', ({ params }) => notes.get(params.id));

  const save = async ({ req, params, query }) => {
    const body = await readJson(req, NOTE_BODY_LIMIT);
    return notes.save(params.id, body, { force: body.force === true || query.get('force') === '1' });
  };
  router.put('/api/notes/:id', save);
  router.post('/api/notes/:id/save', save); // navigator.sendBeacon alias

  router.patch('/api/notes/:id', async ({ req, params }) => notes.patch(params.id, await readJson(req)));

  router.delete('/api/notes/:id', ({ params }) => {
    notes.remove(params.id);
    return { ok: true };
  });

  router.post('/api/notes/:id/restore', ({ params }) => {
    notes.restore(params.id);
    return { ok: true };
  });

  router.post('/api/notes/:id/duplicate', ({ params }) => notes.duplicate(params.id));

  router.get('/api/notes/:id/revisions', ({ params }) => ({ revisions: notes.revisions(params.id) }));
  router.get('/api/notes/:id/revisions/:rid', ({ params }) => notes.revision(params.id, params.rid));
  router.post('/api/notes/:id/revisions/:rid/restore', ({ params }) => notes.restoreRevision(params.id, params.rid));

  router.get('/api/notes/:id/export', ({ params, query, res }) => {
    const note = notes.get(params.id);
    const format = ['txt', 'md', 'csv', 'html', 'json'].includes(query.get('format')) ? query.get('format') : 'txt';
    const side = ['original', 'translation', 'both'].includes(query.get('side')) ? query.get('side') : 'original';
    const title = notes.displayTitle(note);
    const out = renderExport(note, { format, side, tagMap: buildTagMap(settings().tags), title });
    const headers = query.get('inline') === '1' ? {} : { 'Content-Disposition': contentDisposition(`${title}${side === 'original' ? '' : ` (${side})`}.${out.ext}`) };
    sendText(res, 200, out.body, out.type, { 'Cache-Control': 'no-store', ...headers });
    return undefined;
  });

  // Quick "add a tag" from the editor's tag picker.
  router.post('/api/tags', async ({ req }) => {
    const body = await readJson(req);
    const tag = normalizeTag(body);
    if (!tag.name || !/^[A-Z]/.test(tag.name)) throw new HttpError(400, 'Tag names use letters, digits, _ or - and start with a letter');
    const tags = settings().tags.filter((t) => t.name !== tag.name);
    tags.push(tag);
    return { tags: settingsSvc.set({ tags }).tags };
  });

  // Translation for the editor (same-origin; the public middleman API lives under /api/v1).
  router.post('/api/translate', async ({ req }) => {
    const body = await readJson(req, 512 * 1024);
    const texts = Array.isArray(body.texts) ? body.texts : Array.isArray(body.items) ? body.items.map((i) => i?.text ?? '') : null;
    if (!texts) throw new HttpError(400, 'Send { texts: [...] }');
    if (texts.length > 1000) throw new HttpError(413, 'At most 1000 texts per request');
    return translator.translate({
      texts: texts.map((t) => String(t ?? '')),
      source: body.source,
      target: body.target,
      engine: body.engine,
      markup: body.markup !== false,
    });
  });

  router.post('/api/translate/browser', async ({ req }) => {
    const body = await readJson(req, 1024 * 1024);
    return { stored: translator.storeBrowserResults({ ...body, markup: body.markup !== false }) };
  });
}
