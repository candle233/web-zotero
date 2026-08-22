'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectIdentifier,
  resolveIdentifier,
  parseBibtex,
  parseArxivAtom,
  cslJsonToItem,
  itemToCslJson,
  crossrefMessageToCsl,
} = require('../src/metadata');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('detectIdentifier classifies DOI, arXiv, BibTeX, ISBN and garbage', () => {
  assert.deepEqual(detectIdentifier('10.1145/3092829'), { type: 'doi', value: '10.1145/3092829' });
  assert.equal(detectIdentifier('https://doi.org/10.1038/s41586-021-03819-2.').type, 'doi');
  assert.equal(detectIdentifier('arXiv:2401.14196v2').type, 'arxiv');
  assert.equal(detectIdentifier('hep-th/9901001').type, 'arxiv');
  assert.equal(detectIdentifier('@book{tolkien54, title={The Lord of the Rings}}').type, 'bibtex');
  assert.equal(detectIdentifier('978-0-262-03384-8').type, 'isbn');
  assert.equal(detectIdentifier('just some words').type, 'unknown');
});

test('resolveIdentifier fetches CSL-JSON via DOI content negotiation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), accept: options.headers.accept });
    return jsonResponse({
      id: 'https://doi.org/10.9999/att',
      type: 'article-journal',
      title: 'Attention Is All You Need',
      author: [{ family: 'Vaswani', given: 'Ashish' }],
      'container-title': 'NeurIPS',
      issued: { 'date-parts': [[2017]] },
      DOI: '10.9999/att',
    });
  };
  const result = await resolveIdentifier('10.9999/att', { fetchImpl });
  assert.equal(result.identifierType, 'doi');
  assert.match(result.source, /doi\.org/);
  assert.equal(calls[0].url, 'https://doi.org/10.9999/att');
  assert.equal(calls[0].accept, 'application/vnd.citationstyles.csl+json');
  assert.equal(result.item.itemType, 'journalArticle');
  assert.equal(result.item.title, 'Attention Is All You Need');
  assert.equal(result.item.fields.date, '2017-01-01');
  assert.deepEqual(result.item.creators[0], { creatorType: 'author', orderIndex: 0, firstName: 'Ashish', lastName: 'Vaswani' });
});

test('resolveIdentifier falls back to Crossref when doi.org fails', async () => {
  let call = 0;
  const fetchImpl = async url => {
    call += 1;
    if (call === 1) return jsonResponse({ error: 'boom' }, 500); // doi.org fails
    assert.match(String(url), /api\.crossref\.org\/works\/10\.9999\/cr/);
    return jsonResponse({
      message: {
        DOI: '10.9999/cr',
        type: 'journal-article',
        title: ['A Crossref Article'],
        author: [{ given: 'Grace', family: 'Hopper' }],
        'container-title': ['Journal of Testing'],
        volume: '7',
        issue: '2',
        page: '1--20',
        issued: { 'date-parts': [[1999, 5]] },
        ISSN: ['1234-5678'],
      },
    });
  };
  const result = await resolveIdentifier('doi:10.9999/cr', { fetchImpl });
  assert.match(result.source, /Crossref/);
  assert.equal(result.item.title, 'A Crossref Article');
  assert.equal(result.item.fields.publicationTitle, 'Journal of Testing');
  assert.equal(result.item.fields.pages, '1-20');
  assert.equal(result.item.fields.ISSN, '1234-5678');
});

test('resolveIdentifier throws 502 when both DOI providers fail', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'down' }, 503);
  await assert.rejects(() => resolveIdentifier('10.9999/down', { fetchImpl }), error => error.statusCode === 502);
});

test('resolveIdentifier parses arXiv Atom XML', async () => {
  const atom = `<?xml version="1.0"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>http://arxiv.org/abs/2401.14196v2</id>
      <published>2024-01-25T08:00:00Z</published>
      <updated>2024-02-01T00:00:00Z</updated>
      <title>Self-Refining Networks</title>
      <summary>We propose a method that refines itself &amp; improves accuracy.</summary>
      <author><name>Alice Zhang</name></author>
      <author><name>Bob Li</name></author>
      <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.3/z</arxiv:doi>
    </entry>
  </feed>`;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => atom });
  const result = await resolveIdentifier('arXiv:2401.14196v2', { fetchImpl });
  assert.equal(result.identifierType, 'arxiv');
  assert.equal(result.item.itemType, 'preprint');
  assert.equal(result.item.title, 'Self-Refining Networks');
  assert.equal(result.item.fields.publicationTitle, 'arXiv');
  assert.equal(result.item.creators.length, 2);
  assert.equal(result.item.creators[0].lastName, 'Alice Zhang');
  assert.equal(result.csl.DOI, '10.3/z');
  assert.match(result.item.fields.abstractNote, /refines itself & improves accuracy/);
});

test('parseArxivAtom upgrades entries with a journal ref to journal articles', () => {
  const xml = `<entry><id>http://arxiv.org/abs/1901.1</id><title>Old</title><summary>s</summary>
    <published>2019-01-01T00:00:00Z</published><author><name>X Y</name></author>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Nature 575, 7 (2019)</arxiv:journal_ref></entry>`;
  const record = parseArxivAtom(xml);
  assert.equal(record.type, 'article-journal');
  assert.equal(record['container-title'], 'Nature 575, 7 (2019)');
});

test('parseBibtex parses entries, authors, field mapping and page ranges', () => {
  const blob = `@article{boyd2004convex,
    author = {Boyd, Stephen and Vandenberghe, Lieven},
    title = {Convex Optimization},
    journal = {Cambridge University Press},
    year = {2004},
    volume = {1},
    pages = {1--716},
    doi = {10.1017/CBO9780511804441},
    abstract = {A book about convex analysis.}
  }
  @inproceedings{vaswani2017attention,
    author = {Ashish Vaswani and Noam Shazeer},
    title = {Attention Is All You Need},
    booktitle = {NeurIPS},
    year = {2017},
    pages = {5998--6008}
  }`;
  const records = parseBibtex(blob);
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'article-journal');
  assert.deepEqual(records[0].author, [
    { family: 'Boyd', given: 'Stephen' },
    { family: 'Vandenberghe', given: 'Lieven' },
  ]);
  assert.equal(records[0]['container-title'], 'Cambridge University Press');
  assert.equal(records[0].page, '1-716');
  assert.equal(records[0].DOI, '10.1017/CBO9780511804441');
  assert.equal(records[0].issued['date-parts'][0][0], 2004);
  assert.equal(records[1].type, 'paper-conference');
  assert.deepEqual(records[1].author[0], { family: 'Vaswani', given: 'Ashish' });
});

test('resolveIdentifier handles BibTeX input end to end', async () => {
  const result = await resolveIdentifier('@misc{demo, title={Demo Entry}, author={Doe, Jane}, year={2020}}');
  assert.equal(result.identifierType, 'bibtex');
  assert.equal(result.item.title, 'Demo Entry');
  assert.equal(result.items.length, 1);
  assert.equal(result.item.creators[0].lastName, 'Doe');
});

test('resolveIdentifier rejects unrecognizable input with 400', async () => {
  await assert.rejects(() => resolveIdentifier('not an identifier at all'), error => error.statusCode === 400);
});

test('cslJsonToItem and itemToCslJson round-trip losslessly', () => {
  const csl = {
    id: 'demo-1',
    type: 'article-journal',
    title: 'Round Trip',
    author: [{ family: 'Curie', given: 'Marie' }, { literal: 'CERN Collaboration' }],
    'container-title': 'Annals of Testing',
    volume: '12',
    issue: '3',
    page: '44-51',
    DOI: '10.55/rt',
    URL: 'https://example.org/rt',
    ISSN: '0000-0000',
    publisher: 'Test Press',
    language: 'en-US',
    abstract: 'An abstract.',
    issued: { 'date-parts': [[2021, 6, 15]] },
    customField: 'kept in extra',
  };
  const item = cslJsonToItem(csl);
  assert.equal(item.itemType, 'journalArticle');
  assert.equal(item.creators[1].name, 'CERN Collaboration');
  assert.equal(item.fields.date, '2021-06-15');
  assert.equal(item.extra.customField, 'kept in extra');

  const exported = itemToCslJson(item);
  assert.equal(exported.type, 'article-journal');
  assert.equal(exported.title, 'Round Trip');
  assert.deepEqual(exported.author, csl.author);
  assert.equal(exported['container-title'], 'Annals of Testing');
  assert.equal(exported.volume, '12');
  assert.equal(exported.page, '44-51');
  assert.equal(exported.DOI, '10.55/rt');
  assert.equal(exported.issued['date-parts'][0][0], 2021);
  assert.equal(exported.customField, 'kept in extra');
});

test('cslJsonToItem maps Crossref-style types from doi.org content negotiation', () => {
  // The doi.org transform endpoint emits Crossref record types ("journal-article")
  // rather than CSL item types ("article-journal") — both must map correctly.
  assert.equal(cslJsonToItem({ id: 'x', type: 'journal-article', title: 'A' }).itemType, 'journalArticle');
  assert.equal(cslJsonToItem({ id: 'x', type: 'proceedings-article', title: 'A' }).itemType, 'conferencePaper');
  assert.equal(cslJsonToItem({ id: 'x', type: 'posted-content', title: 'A' }).itemType, 'preprint');
  assert.equal(cslJsonToItem({ id: 'x', type: 'book-chapter', title: 'A' }).itemType, 'bookSection');
});

test('crossrefMessageToCsl maps types and cleans page ranges', () => {
  const csl = crossrefMessageToCsl({
    DOI: '10.9/x',
    type: 'proceedings-article',
    title: ['Proc Paper'],
    author: [{ name: 'ACM' }],
    page: '10--20',
    issued: { 'date-parts': [[2020]] },
  });
  assert.equal(csl.type, 'paper-conference');
  assert.equal(csl.page, '10-20');
  assert.deepEqual(csl.author, [{ given: '', family: '', literal: 'ACM' }]);
});
