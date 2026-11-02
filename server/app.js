import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createSettings } from './settings.js';
import { Translator } from './translator.js';
import { createNotesService } from './notes.js';
import {
  Router, HttpError, sendJson, sendText, serveStatic, sendBuffer, compressEntry, clientIp, checkBasicAuth, RateLimiter,
} from './http.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicApi } from './routes/public-api.js';

const STATIC_PREFIXES = ['/assets/', '/shared/'];
const STATIC_FILES = new Set(['/favicon.svg', '/favicon.ico', '/manifest.webmanifest', '/sw.js', '/robots.txt']);

export function createApp(config) {
  const store = openDb(config.dataDir);
  const settingsSvc = createSettings(store);
  const settings = settingsSvc.get;
  const translator = new Translator({ store, settings, testMode: config.testMode });
  const notes = createNotesService({ store, settings });
  const limiter = new RateLimiter();
  const router = new Router();
  const deps = { config, store, settings, settingsSvc, translator, notes, limiter };
  registerNoteRoutes(router, deps);
  registerPublicApi(router, deps);
  if (config.adminEnabled) registerAdminRoutes(router, deps);

  router.get('/api/health', () => ({ ok: true, version: config.version, time: new Date().toISOString() }));

  // ------------------------------------------------------------ HTML pages
  const pageCache = new Map();
  function page(rel) {
    const file = path.join(config.publicDir, rel);
    const st = fs.statSync(file);
    const s = settings();
    const sig = `${st.mtimeMs}:${s.instanceName}`;
    const hit = pageCache.get(rel);
    if (hit && hit.sig === sig) return hit.entry;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = fs.readFileSync(file, 'utf8')
      .replaceAll('%%BASE%%', esc(`${config.basePath}/`))
      .replaceAll('%%TITLE%%', esc(s.instanceName))
      .replaceAll('%%VERSION%%', esc(config.version));
    const entry = compressEntry(Buffer.from(html), 'text/html; charset=utf-8');
    pageCache.set(rel, { sig, entry });
    return entry;
  }

  function securityHeaders(res, isHtml) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (isHtml) {
      const fa = config.frameAncestors || settings().frameAncestors || "'self'";
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' https://translate.googleapis.com",
        "manifest-src 'self'",
        "worker-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        `frame-ancestors ${fa}`,
      ].join('; '));
    }
  }

  function applyCors(req, res) {
    const allowed = String(settings().apiCors || '').trim();
    if (!allowed) return;
    const origin = req.headers.origin;
    if (allowed === '*') res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && allowed.split(/[\s,]+/).includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad URL' });
    }
    let p = url.pathname;
    try { p = decodeURI(p); } catch { /* keep raw */ }
    const base = config.basePath;
    if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length) || '/';
    p = p.replace(/\/{2,}/g, '/');

    const isApi = p.startsWith('/api/');
    const isAdmin = p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin/');
    const isPublicApi = p.startsWith('/api/v1/') || p.startsWith('/api/libre/');
    securityHeaders(res, !isApi);

    try {
      if (p !== '/api/health') {
        if (config.basicAuth && !checkBasicAuth(req, config.basicAuth)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="CleanTranslate", charset="UTF-8"');
          return sendText(res, 401, 'Authentication required');
        }
        if (isAdmin) {
          if (!config.adminEnabled) throw new HttpError(404, 'Not found');
          if (config.adminAuth && !checkBasicAuth(req, config.adminAuth)) {
            res.setHeader('WWW-Authenticate', 'Basic realm="CleanTranslate admin", charset="UTF-8"');
            return sendText(res, 401, 'Authentication required');
          }
        }
      }

      if (isPublicApi) {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        const ip = clientIp(req, config.trustProxy);
        const lim = limiter.take(ip, settings().apiRateLimit);
        if (!lim.ok) {
          res.setHeader('Retry-After', String(lim.retryAfter));
          throw new HttpError(429, 'Too many requests, slow down');
        }
      }

      if (isApi) {
        const m = router.match(req.method, p);
        if (!m) throw new HttpError(404, `No API route ${req.method} ${p}`);
        if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
        const out = await m.handler({ req, res, params: m.params, query: url.searchParams, method: req.method, ip: clientIp(req, config.trustProxy) });
        if (res.headersSent || res.writableEnded) return;
        return sendJson(res, 200, out ?? { ok: true });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

      if (p === '/' || p === '/index.html' || /^\/n\/[A-Za-z0-9_-]+\/?$/.test(p)) {
        return sendBuffer(req, res, page('index.html'), { 'Cache-Control': 'no-cache' });
      }
      if (isAdmin) {
        return sendBuffer(req, res, page('admin/index.html'), { 'Cache-Control': 'no-cache' });
      }
      if (STATIC_FILES.has(p) || STATIC_PREFIXES.some((pre) => p.startsWith(pre))) {
        const extra = p === '/sw.js' ? { 'Service-Worker-Allowed': `${base}/` } : {};
        if (serveStatic(req, res, config.publicDir, p.slice(1), extra)) return;
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        if (isApi) return sendJson(res, err.status, { error: err.message, ...(err.extra || {}) });
        return sendText(res, err.status, err.message);
      }
      console.error('[error]', req.method, p, err);
      try { store.log('error', 'http', `${req.method} ${p}: ${err.message}`); } catch { /* db closed */ }
      return isApi ? sendJson(res, 500, { error: 'Internal server error' }) : sendText(res, 500, 'Internal server error');
    }
  }

  // ------------------------------------------------------------ maintenance
  function maintenance() {
    try {
      const s = settings();
      const purged = store.purgeTrash(s.trashDays * 86400_000);
      const pruned = store.cachePrune(s.cacheMaxEntries);
      store.pruneLogs(5000);
      if (purged || pruned) store.log('info', 'maintenance', `Purged ${purged} old notes from trash, pruned ${pruned} cache entries`);
    } catch (e) {
      console.error('[maintenance]', e.message);
    }
  }
  const timers = [setTimeout(maintenance, 15_000), setInterval(maintenance, 3600_000)];
  timers.forEach((t) => t.unref());

  return {
    handler,
    store,
    translator,
    settings: settingsSvc,
    close() {
      timers.forEach((t) => clearInterval(t));
      store.close();
    },
  };
}
