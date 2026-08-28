'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { citation, exportFormats, exportCsv, exportJson, exportRis } = require('../src/citation');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeItem = (overrides = {}) => ({
  title: 'Example Paper Title',
  itemType: 'journalArticle',
  key: 'ABC123',
  creators: [
    { firstName: 'John', lastName: 'Doe' },
    { firstName: 'Jane', lastName: 'Smith' }
  ],
  fields: {
    date: '2024-01-15',
    publicationTitle: 'Journal of Examples',
    publisher: 'Example Press',
    DOI: '10.1234/example.2024.001',
    url: 'https://example.com/paper',
    ISSN: '1234-5678',
    abstractNote: 'An example abstract.',
    language: 'en',
    volume: '12',
    issue: '3',
    pages: '45-67'
  },
  tags: ['machine learning', 'AI'],
  collections: ['COLL1'],
  ...overrides
});

// ── APA citation ──────────────────────────────────────────────────────────────

test('citation APA formats authors and year and title', () => {
  const item = makeItem();
  const text = citation(item, 'apa');
  assert.ok(text.includes('Doe'), 'should include last name');
  assert.ok(text.includes('Smith'), 'should include second author');
  assert.ok(text.includes('2024'), 'should include year');
  assert.ok(text.includes('Example Paper Title'), 'should include title');
});

test('citation APA omits missing date (n.d.)', () => {
  const item = makeItem({ fields: {} });
  const text = citation(item, 'apa');
  assert.ok(text.includes('n.d.'), 'should show n.d. when no date');
});

test('citation APA omits empty fields gracefully', () => {
  const item = makeItem({ fields: { DOI: '', url: '' } });
  const text = citation(item, 'apa');
  assert.ok(typeof text === 'string');
  assert.ok(text.length > 0);
});

test('citation APA formats DOI as doi.org link', () => {
  const item = makeItem();
  const text = citation(item, 'apa');
  assert.ok(text.includes('https://doi.org/10.1234'), 'DOI should become a link');
});

test('citation APA falls back to URL when no DOI', () => {
  const item = makeItem({ fields: { DOI: '', url: 'https://example.com/paper' } });
  const text = citation(item, 'apa');
  assert.ok(text.includes('https://example.com/paper'));
});

// ── BibTeX citation ───────────────────────────────────────────────────────────

test('citation BibTeX produces @misc with required fields', () => {
  const item = makeItem();
  const text = citation(item, 'bibtex');
  assert.ok(text.startsWith('@misc{'), 'should start with @misc{');
  assert.ok(text.includes('title = {Example Paper Title}'), 'should have title field');
  assert.ok(text.includes('author = {'), 'should have author field');
  assert.ok(text.includes('year = {2024}'), 'should have year field');
  assert.ok(text.includes('doi = {10.1234'), 'should have doi field');
});

test('citation BibTeX uses unknown when no author', () => {
  const item = makeItem({ creators: [] });
  const text = citation(item, 'bibtex');
  assert.ok(text.includes('unknown'), 'should fall back to "unknown"');
});

test('citation BibTeX omits optional empty fields', () => {
  const item = makeItem({ fields: { DOI: '', url: '' } });
  const text = citation(item, 'bibtex');
  assert.ok(!text.includes('doi ='), 'should not have empty doi');
  assert.ok(!text.includes('url ='), 'should not have empty url');
});

// ── exportFormats ─────────────────────────────────────────────────────────────

test('exportFormats returns both apa and bibtex', () => {
  const formats = exportFormats(makeItem());
  assert.ok('apa' in formats);
  assert.ok('bibtex' in formats);
  assert.ok(typeof formats.apa === 'string');
  assert.ok(typeof formats.bibtex === 'string');
});

// ── RIS export ────────────────────────────────────────────────────────────────

test('exportRis starts with TY and ends with ER', () => {
  const text = exportRis(makeItem());
  assert.ok(text.startsWith('TY  - JOUR'), 'TY should be JOUR for journalArticle');
  assert.ok(text.includes('\r\nER  - \r\n'), 'RIS should end with ER marker');
});

test('exportRis maps itemType to correct RIS type', () => {
  const types = [
    ['journalArticle', 'JOUR'], ['book', 'BOOK'], ['conferencePaper', 'CONF'],
    ['thesis', 'THES'], ['webpage', 'ELEC'], ['report', 'RPRT'],
    ['dataset', 'DATA'], ['unknownType', 'GEN']  // unknown → GEN
  ];
  for (const [itemType, risType] of types) {
    const text = exportRis(makeItem({ itemType }));
    assert.ok(text.startsWith(`TY  - ${risType}`), `${itemType} → ${risType}`);
  }
});

test('exportRis formats authors as Last, First', () => {
  const text = exportRis(makeItem());
  assert.ok(text.includes('AU  - Doe, John'), 'author format: Last, First');
  assert.ok(text.includes('AU  - Smith, Jane'), 'second author');
});

test('exportRis handles missing creators without crashing', () => {
  const text = exportRis(makeItem({ creators: [] }));
  assert.ok(!text.includes('AU  - '));
});

test('exportRis limits tags to 30', () => {
  const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
  const text = exportRis(makeItem({ tags }));
  const tagCount = (text.match(/KW  - tag/g) || []).length;
  assert.equal(tagCount, 30);
});

test('exportRis uses CRLF line endings', () => {
  const text = exportRis(makeItem());
  assert.ok(text.includes('\r\n'), 'RIS uses CRLF line endings');
});

// ── JSON export ───────────────────────────────────────────────────────────────

test('exportJson returns valid JSON with all fields', () => {
  const json = exportJson(makeItem());
  const obj = JSON.parse(json);
  assert.equal(obj.title, 'Example Paper Title');
  assert.equal(obj.itemType, 'journalArticle');
  assert.equal(obj.key, 'ABC123');
  assert.deepEqual(obj.creators, makeItem().creators);
});

test('exportJson round-trips through JSON.parse', () => {
  const item = makeItem();
  const obj = JSON.parse(exportJson(item));
  assert.equal(obj.key, item.key);
  assert.equal(obj.title, item.title);
});

// ── CSV export ────────────────────────────────────────────────────────────────

test('exportCsv returns a string with a header row', () => {
  const csv = exportCsv(makeItem());
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('key,'), 'header row starts with key');
  assert.ok(lines[1].includes('ABC123'), 'data row contains the item key');
});

test('exportCsv quotes fields containing commas', () => {
  const item = makeItem({ title: 'One, Two, and Three' });
  const csv = exportCsv(item);
  // The title with commas should be double-quoted.
  assert.ok(csv.includes('"One, Two, and Three"'), 'commas in title should be quoted');
});

test('exportCsv double-quotes double-quotes inside fields', () => {
  const item = makeItem({ title: 'A "quoted" title' });
  const csv = exportCsv(item);
  assert.ok(csv.includes('"A ""quoted"" title"'), 'double-quotes escaped as ""');
});

test('exportCsv uses semicolon to separate multiple tags', () => {
  const item = makeItem({ tags: ['tag1', 'tag2', 'tag3'] });
  const csv = exportCsv(item);
  assert.ok(csv.includes('tag1; tag2; tag3'), 'tags joined with semicolon');
});
