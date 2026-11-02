// Tiny HTTP helpers: JSON bodies, responses, routing, static files with compression.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, ...headers });
  res.end(data);
}

export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (max ${Math.round(limit / 1024)} KB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  const type = String(req.headers['content-type'] || '');
  const text = buf.toString('utf8');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Minimal router: add(method, '/api/notes/:id', handler). */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    }).replace(/\*$/, '.*') + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) {
        allowed = true;
        continue;
      }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/;
const fileCache = new Map(); // path -> { mtimeMs, size, etag, raw, gzip, br, type }

function loadFile(file) {
  const st = fs.statSync(file);
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    raw,
    type,
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
  };
  if (COMPRESSIBLE.test(type) && raw.length > 1024) {
    entry.gzip = zlib.gzipSync(raw, { level: 9 });
    entry.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } });
  }
  fileCache.set(file, entry);
  return entry;
}

/** Send a buffer, negotiating br/gzip, with ETag support. */
export function sendBuffer(req, res, { raw, type, etag, gzip, br }, headers = {}) {
  const h = { 'Content-Type': type, Vary: 'Accept-Encoding', ...headers };
  if (etag) {
    h.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, h);
      res.end();
      return;
    }
  }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = raw;
  if (br && /\bbr\b/.test(ae)) {
    body = br;
    h['Content-Encoding'] = 'br';
  } else if (gzip && /\bgzip\b/.test(ae)) {
    body = gzip;
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Serve a file from `root`; returns false when it does not exist. */
export function serveStatic(req, res, root, relPath, headers = {}) {
  const file = path.normalize(path.join(root, relPath));
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  let entry;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    entry = loadFile(file);
  } catch {
    return false;
  }
  sendBuffer(req, res, entry, { 'Cache-Control': 'no-cache', ...headers });
  return true;
}

export function compressEntry(raw, type) {
  const entry = {
    raw,
    type,
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
  };
  if (raw.length > 1024) {
    entry.gzip = zlib.gzipSync(raw);
    entry.br = zlib.brotliCompressSync(raw);
  }
  return entry;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '';
}

/** Constant-time check of an "Authorization: Basic" header against "user:pass". */
export function checkBasicAuth(req, expected) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const got = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Simple fixed-window rate limiter keyed by IP. */
export class RateLimiter {
  constructor() {
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, 60_000).unref();
  }

  take(key, limitPerMin) {
    if (!limitPerMin) return { ok: true };
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset < now) {
      e = { count: 0, reset: now + 60_000 };
      this.hits.set(key, e);
    }
    e.count++;
    return { ok: e.count <= limitPerMin, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
}
