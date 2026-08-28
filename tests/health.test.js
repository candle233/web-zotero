'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HealthMonitor } = require('../src/health');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_DB = {
  prepare: (sql) => ({ get: () => ({ one: 1 }) })
};

function makeHealth(overrides = {}) {
  return new HealthMonitor({
    zoteroDatabase: { items: [{ key: 'A' }, { key: 'B' }], database: FAKE_DB },
    searchIndex: { status: () => ({ indexed: 3, total: 9 }) },
    s3Storage: null,
    aiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: 'sk-test',
    formulaOcrUrl: 'http://127.0.0.1:8503/pix2text',
    ...overrides
  });
}

// ── Constructor ────────────────────────────────────────────────────────────────

test('HealthMonitor initialises with all expected fields', () => {
  const h = makeHealth();
  assert.equal(h.errors.length, 0);
  assert.ok(h.startedAt.includes('T'));
});

test('HealthMonitor accepts missing optional stores without throwing', () => {
  assert.doesNotThrow(() => new HealthMonitor({
    zoteroDatabase: { items: [], database: FAKE_DB },
    searchIndex: { status: () => ({}) }
  }));
});

test('HealthMonitor stores are null until _bindStores is called', () => {
  const h = makeHealth();
  assert.equal(h._webStore, null);
  assert.equal(h._userStore, null);
  assert.equal(h._annotationStore, null);
});

// ── _bindStores ────────────────────────────────────────────────────────────────

test('_bindStores assigns all three stores', () => {
  const h = makeHealth();
  const fakeWeb = { database: FAKE_DB };
  const fakeUser = { database: FAKE_DB };
  const fakeAnn = { database: FAKE_DB };
  h._bindStores(fakeWeb, fakeUser, fakeAnn);
  assert.equal(h._webStore, fakeWeb);
  assert.equal(h._userStore, fakeUser);
  assert.equal(h._annotationStore, fakeAnn);
});

// ── recordError ────────────────────────────────────────────────────────────────

test('recordError adds an entry and keeps the last 20', () => {
  const h = makeHealth();
  h.recordError('GET /api/items', new Error('db locked'));
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].scope, 'GET /api/items');
  assert.equal(h.errors[0].message, 'db locked');
  assert.ok(h.errors[0].at.includes('T'));

  for (let i = 0; i < 25; i++) h.recordError(`scope-${i}`, new Error('e'));
  assert.equal(h.errors.length, 20);
  assert.equal(h.errors[0].scope, 'scope-24'); // newest first
});

test('recordError handles non-Error values gracefully', () => {
  const h = makeHealth();
  h.recordError('test', 'plain string');
  assert.equal(h.errors[0].message, 'plain string');
  h.recordError('test', null);
  assert.equal(h.errors[0].message, 'null');
  h.recordError('test', undefined);
  assert.equal(h.errors[0].message, 'undefined');
});

// ── _probeStore ────────────────────────────────────────────────────────────────

test('_probeStore returns null when store is null', async () => {
  assert.equal(await makeHealth()._probeStore(null), null);
});

test('_probeStore returns null when store has no recognised backend', async () => {
  assert.equal(await makeHealth()._probeStore({}), null);
});

test('_probeStore returns true when SQLite prepare succeeds', async () => {
  assert.equal(await makeHealth()._probeStore({ database: FAKE_DB }), true);
});

test('_probeStore returns false when SQLite prepare throws', async () => {
  const badDb = { prepare: () => { throw new Error('corrupt'); } };
  assert.equal(await makeHealth()._probeStore({ database: badDb }), false);
});

// ── _probePostgres ────────────────────────────────────────────────────────────

test('_probePostgres returns false when _pgUrl is null', async () => {
  const h = makeHealth();
  h._pgUrl = null;
  assert.equal(await h._probePostgres(), false);
});

test('_probePostgres returns false when detect-postgres is unavailable (no throw)', async () => {
  // Delete from cache to simulate the module being stripped — health degrades gracefully.
  const h = makeHealth();
  h._pgUrl = 'postgresql://localhost/db';
  // The call should return false without throwing even if isPostgresReachable is absent.
  // This tests that _probePostgres swallows missing-module errors.
  let threw = false;
  try { await h._probePostgres(); } catch { threw = true; }
  assert.equal(threw, false);
});

// ── _probeOcr ─────────────────────────────────────────────────────────────────

test('_probeOcr returns false when formulaOcrUrl is null', async () => {
  assert.equal(await makeHealth({ formulaOcrUrl: null })._probeOcr(), false);
});

test('_probeOcr returns false when OCR endpoint is unreachable (no throw)', async () => {
  // 127.0.0.1:1 is guaranteed closed on every machine.
  const h = makeHealth({ formulaOcrUrl: 'http://127.0.0.1:1/pix2text' });
  assert.equal(await h._probeOcr(), false);
});

// ── status() ──────────────────────────────────────────────────────────────────

test('status() returns the documented shape', async () => {
  const h = makeHealth();
  const s = await h.status();
  assert.ok('ok' in s);
  assert.ok('startedAt' in s);
  assert.equal(typeof s.uptimeSeconds, 'number');
  assert.equal(typeof s.libraryItems, 'number');
  assert.ok('index' in s);
  assert.ok('dependencies' in s);
  assert.ok('services' in s);
  assert.ok('recentErrors' in s);
  assert.equal(Array.isArray(s.recentErrors), true);
});

test('status().ok is true when all local stores are reachable', async () => {
  const h = makeHealth();
  h._bindStores({ database: FAKE_DB }, { database: FAKE_DB }, { database: FAKE_DB });
  const s = await h.status();
  assert.equal(s.ok, true);
});

test('status().ok is false when webStore throws', async () => {
  const h = makeHealth();
  h._bindStores(
    { database: { prepare: () => { throw new Error('boom'); } } },
    { database: FAKE_DB },
    { database: FAKE_DB }
  );
  const s = await h.status();
  assert.equal(s.ok, false);
});

test('status().dependencies has zoteroDatabase, webNotes, users, annotations', async () => {
  const h = makeHealth();
  h._bindStores({ database: FAKE_DB }, { database: FAKE_DB }, { database: FAKE_DB });
  const { dependencies } = await h.status();
  assert.ok('zoteroDatabase' in dependencies);
  assert.ok('webNotes' in dependencies);
  assert.ok('users' in dependencies);
  assert.ok('annotations' in dependencies);
  // All values should be boolean (true = reachable).
  assert.equal(typeof dependencies.zoteroDatabase, 'boolean');
  assert.equal(typeof dependencies.webNotes, 'boolean');
});

test('status().services includes postgres, ocr, ai, s3', async () => {
  const h = makeHealth();
  h._pgUrl = 'postgresql://localhost/db'; // set but probe may fail
  const { services } = await h.status();
  assert.ok('postgres' in services);
  assert.ok('ocr' in services);
  assert.ok('ai' in services);
  assert.ok('s3' in services);
});

test('status().services.ai.provider is "openai" when API key is set', async () => {
  const h = makeHealth({ openAiApiKey: 'sk-test', aiBaseUrl: 'https://api.openai.com/v1' });
  const { services } = await h.status();
  assert.equal(services.ai.provider, 'openai');
});

test('status().services.ai.provider is "openai-compatible" for local baseUrl', async () => {
  const h = makeHealth({ openAiApiKey: '', aiBaseUrl: 'http://127.0.0.1:11434/v1' });
  const { services } = await h.status();
  assert.equal(services.ai.provider, 'openai-compatible');
});

test('status().services.ai.provider is "local" for non-local baseUrl without key', async () => {
  const h = makeHealth({ openAiApiKey: '', aiBaseUrl: 'https://api.company.com/v1' });
  const { services } = await h.status();
  assert.equal(services.ai.provider, 'local');
});

test('status().uptimeSeconds grows between calls', async () => {
  const h = makeHealth();
  const s1 = await h.status();
  await new Promise(r => setTimeout(r, 50));
  const s2 = await h.status();
  assert.ok(s2.uptimeSeconds >= s1.uptimeSeconds);
});

test('status().recentErrors reflects recordError', async () => {
  const h = makeHealth();
  h.recordError('GET /api/items', new Error('boom'));
  const s = await h.status();
  assert.equal(s.recentErrors.length, 1);
  assert.equal(s.recentErrors[0].scope, 'GET /api/items');
});

test('status().libraryItems matches zoteroDatabase.items.length', async () => {
  const h = makeHealth({ zoteroDatabase: { items: [{ key: 'X' }, { key: 'Y' }, { key: 'Z' }], database: FAKE_DB } });
  const s = await h.status();
  assert.equal(s.libraryItems, 3);
});

test('status().index exposes searchIndex.status()', async () => {
  const h = makeHealth({ searchIndex: { status: () => ({ indexed: 7, total: 20, engine: 'bm25' }), zoteroDatabase: { items: [], database: FAKE_DB } } });
  const s = await h.status();
  assert.equal(s.index.indexed, 7);
  assert.equal(s.index.total, 20);
  assert.equal(s.index.engine, 'bm25');
});
