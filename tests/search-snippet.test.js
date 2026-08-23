'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchIndex } = require('../src/search');

function buildIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-search-'));
  const index = new SearchIndex(dir, { refreshItems: async () => [] });
  return { index, dir };
}

test('search() escapes HTML in snippets but keeps <mark> highlights', () => {
  const { index, dir } = buildIndex();
  try {
    index.database.prepare(
      'INSERT INTO documents(item_key, attachment_key, title, authors, text) VALUES (?, ?, ?, ?, ?)'
    ).run('KEY1', 'ATT1', 'Hostile paper', 'A. Author',
      'clean text <img src=x onerror=alert(1)> around the exploit token and more filler words here');
    const results = index.search('exploit');
    assert.equal(results.length, 1);
    const snippet = results[0].snippet;
    assert.ok(snippet.includes('<mark>'), 'highlight markup should survive');
    assert.ok(!snippet.includes('<img'), 'raw HTML must not survive');
    assert.ok(snippet.includes('&lt;img'), 'hostile markup must be escaped');
  } finally {
    index.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search() escapes quotes and ampersands from PDF text', () => {
  const { index, dir } = buildIndex();
  try {
    index.database.prepare(
      'INSERT INTO documents(item_key, attachment_key, title, authors, text) VALUES (?, ?, ?, ?, ?)'
    ).run('KEY2', 'ATT2', 'Quotes paper', 'B. Author',
      'she said "q & a" then targeted the exploit word');
    const [result] = index.search('exploit');
    assert.ok(result.snippet.includes('&quot;') || result.snippet.includes('&amp;'));
    assert.ok(!result.snippet.includes('"q &'));
  } finally {
    index.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
