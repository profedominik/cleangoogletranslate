#!/usr/bin/env node
// CleanTranslate — entry point. Zero npm dependencies; needs Node.js >= 22.13.
import http from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`CleanTranslate needs Node.js 22.13 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const config = loadConfig();
const app = createApp(config);
const server = http.createServer(app.handler);
server.keepAliveTimeout = 65_000;
server.requestTimeout = 120_000;

server.listen(config.port, config.host, () => {
  const where = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}/`;
  console.log(`CleanTranslate ${config.version} listening on ${where}`);
  console.log(`  editor: ${where}   admin: ${where}admin   data: ${config.dataDir}`);
  if (!config.basicAuth && !config.adminAuth) console.log('  note: no authentication configured (set BASIC_AUTH or ADMIN_AUTH="user:pass" to protect it)');
});

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig} received, shutting down...`);
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => {
    app.close();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
