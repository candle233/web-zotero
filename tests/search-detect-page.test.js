'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SearchIndex } = require('../src/search');

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-search-'));
}

function writeCache(storagePath, attachmentKey, text) {
  const folder = path.join(storagePath, attachmentKey);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.zotero-ft-cache'), text, 'utf8');
  return folder;
}

function makeIndex(storagePath) {
  // SearchIndex opens a SQLite index file under DATA_DIR for its own use.
  // We pass a real temp directory so that constructor succeeds; detectPage()
  // only needs zoteroDatabase.storagePath, which is the second argument.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-search-data-'));
  return new SearchIndex(dataDir, { items: [], storagePath });
}

test('detectPage returns 0 for a snippet at the very start of the cache', () => {
  const storage = tempStorage();
  const cache = 'Introduction.\f\fThis is the second page.\f\fAnd the third.';
  writeCache(storage, 'ATT_A', cache);
  const index = makeIndex(storage);
  const result = index.detectPage('ATT_A', 'Introduction');
  assert.equal(result, 0);
});

test('detectPage counts form feeds correctly when snippet is on page N', () => {
  const storage = tempStorage();
  const cache = 'Page one content.\f\fPage two content.\f\fPage three content.';
  writeCache(storage, 'ATT_B', cache);
  const index = makeIndex(storage);
  assert.equal(index.detectPage('ATT_B', 'Page two content'), 1);
  assert.equal(index.detectPage('ATT_B', 'Page three content'), 2);
});

test('detectPage returns null when snippet is not found in the cache', () => {
  const storage = tempStorage();
  writeCache(storage, 'ATT_C', 'This is some content here.');
  const index = makeIndex(storage);
  const result = index.detectPage('ATT_C', 'entirely different text that does not appear');
  assert.equal(result, null);
});

test('detectPage returns null when attachmentKey has no cache file', () => {
  const storage = tempStorage();
  const index = makeIndex(storage);
  const result = index.detectPage('ATT_MISSING', 'any text');
  assert.equal(result, null);
});

test('detectPage returns null when attachmentKey is empty/falsy', () => {
  const storage = tempStorage();
  const index = makeIndex(storage);
  assert.equal(index.detectPage('', 'text'), null);
  assert.equal(index.detectPage(null, 'text'), null);
});

test('detectPage returns null when zoteroDatabase is unavailable (no storagePath)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-search-data-'));
  const index = new SearchIndex(dataDir, { items: [] }); // no storagePath
  const result = index.detectPage('ATT', 'text');
  assert.equal(result, null);
  // Don't rmSync — node:sqlite holds a connection to the file on Windows;
  // let the OS temp cleaner take it after process exit.
});

test('detectPage strips HTML <mark> tags before searching', () => {
  const storage = tempStorage();
  const cache = 'background\fsection\fmachine learning is the focus here';
  writeCache(storage, 'ATT_D', cache);
  const index = makeIndex(storage);
  // Snippet includes highlight markers; detector should strip them.
  const result = index.detectPage('ATT_D', '<mark>machine learning</mark> is the focus here');
  assert.equal(result, 2);
});

test('detectPage normalises whitespace and tabs before matching', () => {
  const storage = tempStorage();
  // Cache uses tabs; snippet has multiple spaces.
  const cache = 'tab1\ttab2\ftab3\t\tdeep content here';
  writeCache(storage, 'ATT_E', cache);
  const index = makeIndex(storage);
  const result = index.detectPage('ATT_E', 'deep  content   here');
  assert.equal(result, 1);
});

test('detectPage falls back to a shorter prefix when exact match fails', () => {
  const storage = tempStorage();
  // Cache has the long form; snippet has extra trailing text.
  const cache = 'abstract content that matters to scientific work';
  writeCache(storage, 'ATT_F', cache);
  const index = makeIndex(storage);
  // Snippet contains "abstract content that matters" (short prefix) plus suffix.
  const result = index.detectPage('ATT_F', 'abstract content that matters to everything else including a long suffix');
  assert.equal(result, 0);
});

test('detectPage returns null for snippet shorter than the prefix threshold (< 24)', () => {
  const storage = tempStorage();
  const cache = 'this is a much longer piece of text that contains many words and phrases';
  writeCache(storage, 'ATT_G', cache);
  const index = makeIndex(storage);
  // Snippet is only 10 chars → too short to be tried as a fallback prefix.
  const result = index.detectPage('ATT_G', 'short');
  assert.equal(result, null);
});

test('detectPage handles multi-byte ellipsis (segment) in snippet', () => {
  const storage = tempStorage();
  const cache = 'first segment\fmiddle segment here\flast segment';
  writeCache(storage, 'ATT_H', cache);
  const index = makeIndex(storage);
  // The snippet includes a U+2026 ellipsis splitting the match.
  const result = index.detectPage('ATT_H', 'first segment…middle segment here');
  // The detector splits on '…' and tries each segment.
  assert.equal(typeof result, 'number');
});
