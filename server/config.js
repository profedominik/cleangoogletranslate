import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function normBase(b) {
  if (!b || b === '/') return '';
  return '/' + String(b).trim().replace(/^\/+|\/+$/g, '');
}

function bool(v, dflt = false) {
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function loadConfig(env = process.env) {
  return {
    version: pkg.version,
    root,
    publicDir: path.join(root, 'public'),
    port: Number(env.PORT) || 8080,
    host: env.HOST || '0.0.0.0',
    // Serve under a sub-path, e.g. BASE_PATH=/translate  ->  https://example.com/translate/
    basePath: normBase(env.BASE_PATH),
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    // Honour X-Forwarded-For / X-Forwarded-Proto from a reverse proxy.
    trustProxy: bool(env.TRUST_PROXY, true),
    // Optional protection (off by default): "user:password"
    basicAuth: env.BASIC_AUTH || '',
    adminAuth: env.ADMIN_AUTH || '',
    adminEnabled: bool(env.ADMIN_ENABLED, true),
    // Who may embed the app in an <iframe> (CSP frame-ancestors). Overrides the admin setting when set.
    frameAncestors: env.FRAME_ANCESTORS || '',
    // Lets the e2e tests use the offline "echo" engine.
    testMode: bool(env.CT_TEST_MODE, false),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
