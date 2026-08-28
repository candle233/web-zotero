'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_ENTRY = path.join(ROOT, 'src', 'server.js');
const PASSWORD = 'test-pass-123';

function zoteroEnv() {
  const home = process.env.USERPROFILE || 'C:/Users/me';
  return {
    ZOTERO_DATABASE: path.join(home, 'Zotero', 'zotero.sqlite'),
    ZOTERO_STORAGE: path.join(home, 'Zotero', 'storage')
  };
}

function httpGet(port, urlPath, timeoutMs = 5000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`GET ${urlPath} timed out`)); });
  });
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`Port ${port} not reachable after ${timeoutMs}ms`));
        else setTimeout(attempt, 150);
      });
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.connect(port, host);
    };
    attempt();
  });
}

async function withServer(env, port, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-e2e-'));
  const fullEnv = { ...zoteroEnv(), ...env, DATA_DIR: dataDir, PORT: String(port) };
  const child = spawn(process.execPath, [PROJECT_ENTRY], {
    env: { ...process.env, ...fullEnv },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', d => process.stdout.write(`[server:${port}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[server:${port}] ${d}`));
  child.unref();
  try {
    await waitForPort(port);
    return await fn({ port, dataDir });
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1500));
    if (!child.killed) child.kill('SIGKILL');
    try { await fsp.rm(dataDir, { recursive: true, force: true }); } catch {}
  }
}

const AUTH = { authorization: `Bearer ${PASSWORD}` };

// ── Tests ──────────────────────────────────────────────────────────────────

test('server boots with WEB_PASSWORD (legacy mode) and returns 200 on /api/health', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18601, async ({ port }) => {
    const res = await httpGet(port, '/api/health', 5000, AUTH);
    assert.equal(res.status, 200);
    const health = JSON.parse(res.body);
    assert.ok(['legacy', 'users'].includes(health.auth.mode), `expected legacy or users, got ${health.auth.mode}`);
    assert.equal(typeof health.libraryItems, 'number');
    assert.ok(health.libraryItems >= 0);
  });
});

test('server returns 404 for unknown static path', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18602, async ({ port }) => {
    const res = await httpGet(port, '/no-such-static-file', 5000, AUTH);
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'Not found');
  });
});

test('server returns items list endpoint', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18603, async ({ port }) => {
    const res = await httpGet(port, '/api/items?limit=1', 5000, AUTH);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(typeof data.count, 'number');
    assert.ok(Array.isArray(data.items));
    assert.ok(typeof data.hasMore === 'boolean');
  });
});

test('server returns search endpoint with valid mode', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18604, async ({ port }) => {
    const res = await httpGet(port, '/api/search?q=test&limit=2', 5000, AUTH);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.query, 'test');
    assert.ok(['lexical', 'semantic', 'hybrid'].includes(data.mode));
    assert.ok(Array.isArray(data.results));
    assert.ok(typeof data.index === 'object');
    assert.ok(typeof data.index.indexed === 'number');
  });
});

test('server returns tags endpoint', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18605, async ({ port }) => {
    const res = await httpGet(port, '/api/tags', 5000, AUTH);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.tags));
  });
});

test('server returns collections endpoint', { timeout: 25000 }, async () => {
  await withServer({ WEB_PASSWORD: PASSWORD }, 18606, async ({ port }) => {
    const res = await httpGet(port, '/api/collections', 5000, AUTH);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.collections));
  });
});
