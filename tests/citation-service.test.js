'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCitations, listStyles } = require('../src/citation-service');

const INTERNAL_ITEM = {
  key: 'DEMO1',
  itemType: 'journalArticle',
  title: 'Attention Is All You Need',
  creators: [
    { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
    { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
  ],
  fields: {
    publicationTitle: 'Advances in Neural Information Processing Systems',
    volume: '30',
    issue: '',
    pages: '5998-6008',
    date: '2017-06-12',
    DOI: '10.55/attention',
    url: '',
    ISSN: '1049-5258',
  },
};

test('listStyles exposes bundled CSL styles and locales', () => {
  const { styles, locales } = listStyles();
  const ids = styles.map(style => style.id);
  assert.deepEqual(ids.sort(), ['apa', 'gb-t-7714-2015', 'ieee', 'nature']);
  assert.ok(styles.every(style => style.title.length > 0));
  assert.deepEqual(locales, ['en-US', 'zh-CN']);
});

test('formatCitations produces bibliography HTML for every bundled style', () => {
  for (const style of ['apa', 'ieee', 'nature', 'gb-t-7714-2015']) {
    const result = formatCitations({ items: [INTERNAL_ITEM], style, lang: 'en-US' });
    assert.equal(result.style, style);
    assert.equal(result.mode, 'bibliography');
    assert.equal(result.entries.length, 1);
    const html = result.entries[0].html;
    assert.ok(html.includes('Attention Is All You Need'), `${style} output missing title: ${html}`);
    assert.ok(/csl-entry|Vaswani/.test(html), `${style} output unexpected: ${html}`);
    if (result.engine === 'citeproc-js') assert.ok(/class="csl-entry"/.test(html), `${style} citeproc output missing csl-entry`);
    if (result.engine === 'fallback') assert.ok(result.warning, 'fallback engine must explain itself');
  }
});

test('formatCitations uses the citeproc-js engine when available', () => {
  const result = formatCitations({ items: [INTERNAL_ITEM], style: 'apa', lang: 'en-US' });
  if (result.engine !== 'citeproc-js') {
    assert.match(result.warning, /citeproc-js is not installed|style file/);
  } else {
    assert.match(result.entries[0].html, /Vaswani/);
    assert.match(result.entries[0].html, /2017/);
    assert.match(result.entries[0].html, /10\.55\/attention|doi\.org/);
  }
});

test('formatCitations formats zh-CN locale with the GB-T style', () => {
  const result = formatCitations({ items: [INTERNAL_ITEM], style: 'gb-t-7714-2015', lang: 'zh-CN' });
  assert.equal(result.lang, 'zh-CN');
  assert.ok(result.entries[0].html.includes('Attention Is All You Need'));
});

test('bibliography entry ids follow citeproc output order after style re-sorting', () => {
  const make = (key, title, lastName) => ({
    key,
    itemType: 'journalArticle',
    title,
    creators: [{ creatorType: 'author', firstName: 'B', lastName }],
    fields: { date: '2020-01-01', publicationTitle: 'J' },
  });
  // APA sorts by author; pass items in reverse so input order != output order.
  const result = formatCitations({
    items: [make('ZED1', 'Zebra paper', 'Zed'), make('ALP1', 'Alpha paper', 'Alpha')],
    style: 'apa',
  });
  const plain = result.entries.map(entry => entry.html.replace(/<[^>]+>/g, ''));
  assert.equal(result.entries[0].id, 'ALP1');
  assert.match(plain[0], /Alpha paper/);
  assert.equal(result.entries[1].id, 'ZED1');
  assert.match(plain[1], /Zebra paper/);
});

test('formatCitations supports in-text citation mode', () => {
  const result = formatCitations({ items: [INTERNAL_ITEM, INTERNAL_ITEM], style: 'apa', mode: 'in-text' });
  assert.equal(result.mode, 'in-text');
  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) assert.ok(entry.html.length > 0);
});

test('formatCitations batches multiple items into ordered entries', () => {
  const second = { ...INTERNAL_ITEM, key: 'DEMO2', title: 'Second Paper' };
  const result = formatCitations({ items: [INTERNAL_ITEM, second], style: 'ieee' });
  assert.deepEqual(result.entries.map(entry => entry.id), ['DEMO1', 'DEMO2']);
});

test('formatCitations accepts raw CSL-JSON items too', () => {
  const result = formatCitations({
    items: [{ id: 'raw1', type: 'book', title: 'Raw CSL Book', author: [{ family: 'Turing', given: 'Alan' }], issued: { 'date-parts': [[1950]] } }],
    style: 'apa',
  });
  assert.ok(result.entries[0].html.includes('Raw CSL Book'));
});

test('formatCitations rejects empty item lists with 400', () => {
  assert.throws(() => formatCitations({ items: [] }), error => error.statusCode === 400);
  assert.throws(() => formatCitations({}), error => error.statusCode === 400);
});

test('unknown styles and locales fall back to defaults without failing', () => {
  const result = formatCitations({ items: [INTERNAL_ITEM], style: 'chicago', lang: 'fr-FR' });
  assert.equal(result.style, 'apa');
  assert.equal(result.lang, 'en-US');
});
