import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

/** Start an app on a random port with a fresh data dir. */
export async function startApp(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, CT_TEST_MODE: '1', ...env });
  const app = createApp(config);
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${config.basePath}`;
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    app,
    base,
    config,
    req,
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b = {}, h) => req('POST', p, b, h),
    put: (p, b = {}, h) => req('PUT', p, b, h),
    patch: (p, b = {}, h) => req('PATCH', p, b, h),
    del: (p, h) => req('DELETE', p, undefined, h),
    async close() {
      await new Promise((r) => server.close(r));
      app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
