import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENGINE_TYPES, isConfigured, maskConfig, isMasked } from '../engines/index.js';
import { TAG_SUGGESTIONS, DEFAULT_TAGS, newId } from '../../public/shared/markup.js';
import { HttpError, readJson, sendText } from '../http.js';
import { day } from '../db.js';
import { DEFAULT_SETTINGS } from '../settings.js';

const startedAt = Date.now();

function typeMeta(def) {
  return {
    type: def.type,
    label: def.label,
    category: def.category,
    signup: def.signup,
    serverSide: def.serverSide,
    docs: def.docs,
    description: def.description,
    notes: def.notes,
    limits: def.limits,
    fields: def.fields,
    presets: def.presets || null,
  };
}

function cleanConfig(def, incoming, previous = {}) {
  const out = {};
  for (const f of def.fields) {
    let v = incoming?.[f.key];
    if (v === undefined) v = previous[f.key];
    if (f.type === 'password' && isMasked(v)) v = previous[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.key] = n;
    } else if (f.type === 'checkbox') {
      out[f.key] = !!v;
    } else {
      out[f.key] = String(v).slice(0, 8000);
    }
  }
  return out;
}

export function registerAdminRoutes(router, { store, settings, settingsSvc, translator, notes, config }) {
  const engineView = (row) => {
    const def = ENGINE_TYPES[row.type];
    const monthStart = day().slice(0, 8) + '01';
    return {
      ...row,
      config: maskConfig(row.type, row.config),
      status: translator.status(row),
      usage: { today: store.usageTotals(row.id, day()), month: store.usageTotals(row.id, monthStart) },
      meta: typeMeta(def),
    };
  };

  router.get('/api/admin/overview', () => {
    const s = settings();
    const usage = store.usageSince(30);
    const today = day();
    const todayRows = usage.filter((u) => u.day === today);
    const engines = translator.rows().map((r) => ({ id: r.id, name: r.name, type: r.type, enabled: r.enabled, inAuto: r.inAuto, ...translator.status(r) }));
    return {
      version: config.version,
      instanceName: s.instanceName,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      stats: store.stats(),
      cache: store.cacheStats(),
      dbBytes: store.sizeBytes(),
      today: {
        requests: todayRows.reduce((a, u) => a + u.requests, 0),
        chars: todayRows.reduce((a, u) => a + u.chars, 0),
        errors: todayRows.reduce((a, u) => a + u.errors, 0),
        cacheHits: todayRows.reduce((a, u) => a + u.cache_hits, 0),
      },
      usage,
      engines,
      autoChain: translator.autoChain().map((r) => r.id),
      recentLogs: store.listLogs({ limit: 8 }),
      recentNotes: store.listNotes({ limit: 6 }),
    };
  });

  // ---------------------------------------------------------------- settings
  router.get('/api/admin/settings', () => ({ settings: settings(), defaults: DEFAULT_SETTINGS, tagSuggestions: TAG_SUGGESTIONS, defaultTags: DEFAULT_TAGS }));
  router.put('/api/admin/settings', async ({ req }) => {
    const s = settingsSvc.set(await readJson(req));
    store.log('info', 'admin', 'Settings updated');
    return { settings: s };
  });

  // ---------------------------------------------------------------- engines
  router.get('/api/admin/engines', () => ({
    engines: translator.rows().map(engineView),
    types: Object.values(ENGINE_TYPES).filter((d) => d.type !== 'google-browser').map(typeMeta),
    autoChain: translator.autoChain().map((r) => r.id),
  }));

  router.post('/api/admin/engines', async ({ req }) => {
    const body = await readJson(req);
    const def = ENGINE_TYPES[body.type];
    if (!def || def.type === 'google-browser') throw new HttpError(400, 'Unknown engine type');
    const base = String(body.name || def.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || def.type;
    let id = base;
    while (store.getEngineRow(id)) id = `${base}-${newId().slice(0, 4)}`;
    const maxPrio = Math.max(0, ...translator.rows().map((r) => r.priority));
    store.upsertEngineRow({
      id, type: def.type, name: String(body.name || def.label).slice(0, 80), enabled: body.enabled !== false,
      inAuto: !!body.inAuto, priority: maxPrio + 10, config: cleanConfig(def, body.config), builtin: false,
    });
    store.log('info', 'admin', `Engine "${id}" added`, { type: def.type });
    return engineView(store.getEngineRow(id));
  });

  router.put('/api/admin/engines/:id', async ({ req, params }) => {
    const row = store.getEngineRow(params.id);
    if (!row) throw new HttpError(404, 'Unknown engine');
    const body = await readJson(req);
    const def = ENGINE_TYPES[row.type];
    store.upsertEngineRow({
      ...row,
      name: body.name !== undefined ? String(body.name).slice(0, 80) || row.name : row.name,
      enabled: body.enabled !== undefined ? !!body.enabled : row.enabled,
      inAuto: body.inAuto !== undefined ? !!body.inAuto : row.inAuto,
      priority: body.priority !== undefined ? Number(body.priority) || row.priority : row.priority,
      config: body.config !== undefined ? cleanConfig(def, body.config, row.config) : row.config,
    });
    translator.resetCooldown(row.id);
    store.log('info', 'admin', `Engine "${row.id}" updated`);
    return engineView(store.getEngineRow(row.id));
  });

  router.delete('/api/admin/engines/:id', ({ params }) => {
    const row = store.getEngineRow(params.id);
    if (!row) throw new HttpError(404, 'Unknown engine');
    if (row.builtin) throw new HttpError(400, 'Built-in engines can be disabled but not deleted');
    store.deleteEngineRow(row.id);
    store.log('info', 'admin', `Engine "${row.id}" deleted`);
    return { ok: true };
  });

  router.post('/api/admin/engines/order', async ({ req }) => {
    const { ids } = await readJson(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'Send { ids: [...] }');
    store.tx(() => {
      ids.forEach((id, i) => {
        const row = store.getEngineRow(String(id));
        if (row) store.upsertEngineRow({ ...row, priority: (i + 1) * 10 });
      });
    });
    return { autoChain: translator.autoChain().map((r) => r.id) };
  });

  router.post('/api/admin/engines/:id/test', async ({ req, params }) => {
    const body = await readJson(req);
    return translator.test(params.id, { text: body.text || undefined, source: body.source || 'en', target: body.target || 'es' });
  });

  router.post('/api/admin/engines/:id/reset', ({ params }) => {
    translator.resetCooldown(params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- usage / logs
  router.get('/api/admin/usage', ({ query }) => ({ usage: store.usageSince(Math.min(Math.max(Number(query.get('days')) || 30, 1), 400)) }));

  router.get('/api/admin/logs', ({ query }) => ({
    logs: store.listLogs({ level: String(query.get('level') || ''), limit: Math.min(Number(query.get('limit')) || 200, 1000), before: Number(query.get('before')) || 0 }),
  }));
  router.delete('/api/admin/logs', () => ({ deleted: store.clearLogs() }));

  // ---------------------------------------------------------------- cache
  router.get('/api/admin/cache', ({ query }) => ({
    stats: store.cacheStats(),
    entries: store.cacheSearch({
      q: String(query.get('q') || '').slice(0, 200),
      engine: String(query.get('engine') || ''),
      limit: Math.min(Number(query.get('limit')) || 100, 500),
      offset: Number(query.get('offset')) || 0,
    }),
  }));
  router.delete('/api/admin/cache', ({ query }) => {
    const n = store.cacheClear(String(query.get('engine') || ''));
    store.log('info', 'admin', `Cache cleared (${n} entries)`);
    return { deleted: n };
  });
  router.delete('/api/admin/cache/:key', ({ params }) => ({ deleted: store.cacheDelete(params.key) }));

  // ---------------------------------------------------------------- notes
  router.get('/api/admin/notes', ({ query }) => ({
    notes: store.listNotes({ q: String(query.get('q') || ''), trash: query.get('trash') === '1', limit: 1000 }),
  }));
  router.post('/api/admin/notes/:id/restore', ({ params }) => {
    notes.restore(params.id);
    return { ok: true };
  });
  router.delete('/api/admin/notes/:id', ({ params }) => {
    notes.purge(params.id);
    return { ok: true };
  });
  router.post('/api/admin/trash/empty', () => {
    const n = store.purgeTrash(0);
    store.log('info', 'admin', `Trash emptied (${n} notes)`);
    return { deleted: n };
  });

  // ---------------------------------------------------------------- backup / import
  router.get('/api/admin/backup', ({ res }) => {
    const tmp = path.join(os.tmpdir(), `cleantranslate-backup-${Date.now()}.db`);
    store.backupTo(tmp);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    sendText(res, 200, buf, 'application/vnd.sqlite3', {
      'Content-Disposition': `attachment; filename="cleantranslate-${day()}.db"`, 'Cache-Control': 'no-store',
    });
  });

  router.get('/api/admin/export', ({ res }) => {
    const all = store.listNotes({ limit: 100000 }).map((n) => store.getNote(n.id));
    const body = JSON.stringify({ format: 'cleantranslate-export@1', exportedAt: new Date().toISOString(), settings: settings(), notes: all }, null, 1);
    sendText(res, 200, body, 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="cleantranslate-notes-${day()}.json"`, 'Cache-Control': 'no-store',
    });
  });

  router.post('/api/admin/import', async ({ req }) => {
    const body = await readJson(req, 64 * 1024 * 1024);
    const list = Array.isArray(body.notes) ? body.notes : Array.isArray(body) ? body : null;
    if (!list) throw new HttpError(400, 'Expected { notes: [...] } (a CleanTranslate export)');
    let created = 0;
    for (const n of list) {
      if (!n || !Array.isArray(n.lines)) continue;
      notes.create({ id: n.id, title: n.title, sourceLang: n.sourceLang, targetLang: n.targetLang, engine: n.engine, lines: n.lines });
      created++;
    }
    if (body.settings && body.importSettings) settingsSvc.set(body.settings);
    store.log('info', 'admin', `Imported ${created} notes`);
    return { created };
  });

  router.get('/api/admin/system', () => ({
    version: config.version,
    node: process.version,
    platform: `${os.type()} ${os.release()} (${process.arch})`,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    dataDir: config.dataDir,
    dbFile: store.file,
    dbBytes: store.sizeBytes(),
    basePath: config.basePath || '/',
    port: config.port,
    basicAuth: !!config.basicAuth,
    adminAuth: !!config.adminAuth,
    trustProxy: config.trustProxy,
    frameAncestors: config.frameAncestors || settings().frameAncestors,
    frameAncestorsFromEnv: !!config.frameAncestors,
    engineTypes: Object.keys(ENGINE_TYPES).length,
    configuredEngines: translator.rows().filter((r) => r.enabled && isConfigured(r)).length,
  }));
}
