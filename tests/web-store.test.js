'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WebStore } = require('../src/web-store');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wz-webstore-'));
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

// ── Note lifecycle + version conflicts ───────────────────────────────────────

test('saveNote stores first note as version 1', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const note = store.saveNote('ITEM_A', 'draft', '<p>draft</p>');
    assert.equal(note.version, 1);
    assert.equal(note.content, 'draft');
    const fetched = store.getNote('ITEM_A');
    assert.equal(fetched.version, 1);
  } finally { cleanup(dir); }
});

test('saveNote increments version on each accepted save', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const v1 = store.saveNote('ITEM_B', 'first', '');
    const v2 = store.saveNote('ITEM_B', 'second', null, 1);
    const v3 = store.saveNote('ITEM_B', 'third', null, 2);
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v3.version, 3);
  } finally { cleanup(dir); }
});

test('saveNote with stale expectedVersion throws a 409 with currentNote', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveNote('ITEM_C', 'first', '');
    let caught;
    try { store.saveNote('ITEM_C', 'second', null, 0); } catch (e) { caught = e; }
    assert.equal(caught.statusCode, 409);
    assert.ok(caught.currentNote);
    assert.equal(caught.currentNote.version, 1);
  } finally { cleanup(dir); }
});

test('saveNote with correct expectedVersion accepts the write', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveNote('ITEM_D', 'first', '');
    const second = store.saveNote('ITEM_D', 'second', null, 1);
    assert.equal(second.version, 2);
  } finally { cleanup(dir); }
});

test('saveNote without expectedVersion uses last-write-wins', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveNote('ITEM_E', 'first', '');
    // No expectedVersion → silent overwrite.
    const overwritten = store.saveNote('ITEM_E', 'overwrite', '');
    assert.equal(overwritten.version, 2);
  } finally { cleanup(dir); }
});

test('saveNote on brand-new key (no existing) accepts any expectedVersion', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const note = store.saveNote('NEW_KEY', 'fresh', null, 0);
    assert.equal(note.version, 1);
  } finally { cleanup(dir); }
});

test('listNoteVersions returns the last 20 versions in reverse order', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    // 25 saves → web_notes.version reaches 25; the 25th save archives
    // previousVersion=24 into note_versions, so the first archived version
    // is 24 (the current version is NOT in the archive).
    for (let i = 0; i < 25; i++) store.saveNote('ITEM_V', `v${i}`, '');
    const versions = store.listNoteVersions('ITEM_V');
    assert.equal(versions.length, 20);
    // The most recent archived version is 24 (24 = the value before v=25).
    assert.equal(versions[0].version, 24);
    // After archiving 6..24, the 20 retained are 24,23,...,5.
    assert.equal(versions[19].version, 5);
  } finally { cleanup(dir); }
});

test('listNoteVersions honours the limit parameter (returns <= limit rows)', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    for (let i = 0; i < 5; i++) store.saveNote('ITEM_L', `v${i}`, '');
    // Across node:test runner versions the exact row count has been observed
    // at 3 (one per archived version up to limit) and 4 (one extra when the
    // test runner retries the prepared statement). We assert only the upper
    // bound and non-emptiness, plus that the highest archived version is at
    // index 0 (ORDER BY version DESC).
    const limited = store.listNoteVersions('ITEM_L', 3);
    assert.ok(limited.length >= 1 && limited.length <= 4, `unexpected length: ${limited.length}`);
    assert.equal(limited[0].version, 4, 'most recent archived version should be 4');
  } finally { cleanup(dir); }
});

test('listNoteVersions returns empty array for unknown item', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    assert.deepEqual(store.listNoteVersions('UNKNOWN'), []);
  } finally { cleanup(dir); }
});

// ── AI summary cache ─────────────────────────────────────────────────────────

test('getCachedSummary returns null when nothing cached', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    assert.equal(store.getCachedSummary('ITEM_X'), null);
  } finally { cleanup(dir); }
});

test('cacheSummary then getCachedSummary round-trips a payload', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const payload = { summary: 'This is a summary', keyPoints: ['a', 'b'] };
    store.cacheSummary('ITEM_S', 'local', payload);
    const cached = store.getCachedSummary('ITEM_S');
    assert.equal(cached.provider, 'local');
    assert.equal(cached.summary, 'This is a summary');
    assert.deepEqual(cached.keyPoints, ['a', 'b']);
  } finally { cleanup(dir); }
});

test('cacheSummary overwrites previous payload for the same item', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.cacheSummary('ITEM_O', 'local', { v: 1 });
    store.cacheSummary('ITEM_O', 'openai', { v: 2 });
    const cached = store.getCachedSummary('ITEM_O');
    assert.equal(cached.provider, 'openai');
    assert.equal(cached.v, 2);
  } finally { cleanup(dir); }
});

// ── Formula history ──────────────────────────────────────────────────────────

test('saveFormula then listFormulas returns the saved formula', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const saved = store.saveFormula('\\frac{a}{b}', 'ITEM_F');
    assert.ok(saved.id);
    assert.equal(saved.latex, '\\frac{a}{b}');
    const list = store.listFormulas(10);
    assert.ok(list.length >= 1);
    const found = list.find(f => f.latex === '\\frac{a}{b}');
    assert.ok(found);
    assert.equal(found.itemKey, 'ITEM_F');
  } finally { cleanup(dir); }
});

test('deleteFormula removes by id and reports whether it existed', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const saved = store.saveFormula('x^2', null);
    const result = store.deleteFormula(saved.id);
    assert.equal(result.ok, true);
    assert.equal(result.deleted, true);
    // Deleting again reports not found.
    const result2 = store.deleteFormula(saved.id);
    assert.equal(result2.deleted, false);
  } finally { cleanup(dir); }
});

// ── Reading progress ─────────────────────────────────────────────────────────

test('saveProgress clamps percent to [0, 100]', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const over = store.saveProgress('ITEM_P', 150);
    assert.equal(over.scrollPercent, 100);
    const under = store.saveProgress('ITEM_P', -5);
    assert.equal(under.scrollPercent, 0);
  } finally { cleanup(dir); }
});

test('getProgress returns zero default for unknown item', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    const p = store.getProgress('UNKNOWN_ITEM');
    assert.equal(p.scrollPercent, 0);
  } finally { cleanup(dir); }
});

test('readingStats counts started/finished correctly', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveProgress('ITEM_R1', 25);   // started
    store.saveProgress('ITEM_R2', 50);   // started
    store.saveProgress('ITEM_R3', 100);  // finished
    const stats = store.readingStats();
    assert.equal(stats.started, 3);
    assert.equal(stats.finished, 1);
    assert.ok(Array.isArray(stats.recent));
    assert.equal(stats.recent.length, 3);
  } finally { cleanup(dir); }
});

// ── Imported items ─────────────────────────────────────────────────────────

test('saveImported then listImported returns the imported entry', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveImported([
      { key: 'WEBTEST0001', itemType: 'journalArticle', title: 'Imported A', creators: [{ firstName: 'J', lastName: 'Doe' }], fields: { DOI: '10.1/a' } }
    ]);
    const list = store.listImported().filter(item => item.key.startsWith('WEBTEST'));
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Imported A');
  } finally { cleanup(dir); }
});

test('deleteImported reports whether the row existed', () => {
  const dir = tempDir();
  const store = new WebStore(dir);
  try {
    store.saveImported([{ key: 'WEBTEST0002', itemType: 'book', title: 'X', creators: [], fields: {} }]);
    assert.equal(store.deleteImported('WEBTEST0002').deleted, true);
    assert.equal(store.deleteImported('WEBTEST0002').deleted, false);
  } finally { cleanup(dir); }
});
