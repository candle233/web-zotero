'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SemanticIndex, tokenize, chunkText } = require('../src/semantic');
const { ask } = require('../src/ask');
const { SearchIndex } = require('../src/search');

function filler(sentences, targetChars) {
  let text = '';
  let index = 0;
  while (text.length < targetChars) {
    text += `${sentences[index % sentences.length]} `;
    index += 1;
  }
  return text;
}

const ML_SENTENCES = [
  'The neural network is trained with gradient descent over many epochs.',
  'Deep learning models use attention layers to weight input tokens.',
  'Transformers improved machine translation and language modeling benchmarks.',
  'We report training loss curves for the convolutional baseline networks.'
];
const ART_SENTENCES = [
  'The renaissance painting depicts a sculpture gallery in Florence.',
  'Museum conservators restored the fresco with tempera and gold leaf.',
  'Patrons commissioned altarpieces for churches across Tuscany.',
  'Art historians attribute the canvas to a pupil of the master.'
];
const BIO_SENTENCES = [
  'The protein folds inside the cell nucleus near the membrane.',
  'DNA replication errors can mutate regulatory gene regions.',
  'Enzymes catalyze reactions within the cytoplasm of living cells.',
  'The microscope revealed organelles and mitochondria structures.'
];

function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-sem-'));
  const searchIndex = new SearchIndex(dir, { items: [] });
  const insert = (itemKey, attachmentKey, title, sentences) => {
    searchIndex.database
      .prepare('INSERT INTO documents(item_key, attachment_key, title, authors, text) VALUES (?, ?, ?, ?, ?)')
      .run(itemKey, attachmentKey, title, 'Author', filler(sentences, 3000));
  };
  insert('ML1', 'ML1A', 'Attention networks for translation', ML_SENTENCES);
  insert('ML2', 'ML2A', 'Deep gradient training of transformers', ML_SENTENCES);
  insert('ML3', 'ML3A', 'Language modeling with neural layers', ML_SENTENCES);
  insert('ART1', 'ART1A', 'Renaissance altarpieces in Florence', ART_SENTENCES);
  insert('ART2', 'ART2A', 'Museum restoration of frescos', ART_SENTENCES);
  insert('BIO1', 'BIO1A', 'Protein folding in living cells', BIO_SENTENCES);
  const semanticIndex = new SemanticIndex(dir, searchIndex);
  return { dir, searchIndex, semanticIndex };
}

test('tokenize handles latin words, stopwords and CJK bigrams', () => {
  const tokens = tokenize('The deep learning models are 神经网络 based');
  assert.ok(tokens.includes('deep'));
  assert.ok(tokens.includes('learning'));
  assert.ok(!tokens.includes('the'));
  assert.ok(tokens.includes('神经'));
  assert.ok(tokens.includes('经网'));
  assert.ok(tokens.includes('网络'));
});

test('chunkText splits with overlap and never drops text', () => {
  const text = 'word '.repeat(600);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  const covered = chunks.map(chunk => chunk.text).join(' ');
  assert.ok(covered.includes('word'));
  for (const chunk of chunks) assert.ok(chunk.text.length > 0 && chunk.text.length <= 1300);
});

test('LSA rebuild produces a ready index over the fixture corpus', () => {
  const { semanticIndex } = buildFixture();
  const result = semanticIndex.rebuild();
  assert.equal(result.started, true);
  assert.equal(result.ready, true);
  assert.ok(result.chunks >= 12);
  assert.equal(result.items, 6);
  const status = semanticIndex.status();
  assert.equal(status.ready, true);
  assert.equal(status.items, 6);
  semanticIndex.close();
});

test('semantic search ranks topically matching items first', () => {
  const { semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const results = semanticIndex.search('gradient descent attention training');
  assert.ok(results.length >= 3, `expected results, got ${results.length}`);
  const topKeys = results.slice(0, 3).map(result => result.itemKey);
  const mlCount = topKeys.filter(key => key.startsWith('ML')).length;
  assert.ok(mlCount >= 2, `expected ML items in top 3, got ${topKeys.join(',')}`);
  assert.ok(results[0].snippet.length > 0);
  semanticIndex.close();
});

test('related items come from the same topic cluster', () => {
  const { semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const related = semanticIndex.related('ML1', 5);
  assert.ok(related.length >= 1);
  assert.ok(related[0].key.startsWith('ML'), `top related was ${related[0].key}`);
  assert.ok(related[0].score > 0.05);
  const artEntry = related.find(entry => entry.key.startsWith('ART'));
  if (artEntry) assert.ok(related[0].score > artEntry.score);
  assert.deepEqual(semanticIndex.related('MISSING'), []);
  semanticIndex.close();
});

test('index persists across restarts with stable rankings', () => {
  const { dir, searchIndex, semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const before = semanticIndex.related('ML1', 5).map(entry => entry.key);
  semanticIndex.close();
  const reloaded = new SemanticIndex(dir, searchIndex);
  assert.equal(reloaded.status().ready, true);
  const after = reloaded.related('ML1', 5).map(entry => entry.key);
  assert.deepEqual(after, before);
  reloaded.close();
  searchIndex.database.close();
});

test('ask() extracts a local answer with supporting passages', async () => {
  const { semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const result = await ask({
    question: 'How are the neural networks trained?',
    semanticIndex
  });
  assert.equal(result.provider, 'local');
  assert.ok(result.answer.length > 10);
  assert.ok(result.passages.length >= 1);
  assert.ok(result.passages.every(passage => passage.itemKey.startsWith('ML')));
  semanticIndex.close();
});

test('ask() scopes retrieval to one item and handles empty questions', async () => {
  const { semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const scoped = await ask({ question: 'attention layers', itemKey: 'ML1', semanticIndex });
  assert.ok(scoped.passages.every(passage => passage.itemKey === 'ML1'));
  await assert.rejects(
    () => ask({ question: '   ', semanticIndex }),
    error => error.statusCode === 400
  );
  const noMatch = await ask({ question: 'zzzqqqxxx unmatchable', semanticIndex });
  assert.ok(noMatch.answer.includes('does not directly address') || noMatch.passages.length === 0);
  semanticIndex.close();
});

test('ask() falls back to local extraction when OpenAI fails', async () => {
  const { semanticIndex } = buildFixture();
  semanticIndex.rebuild();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const result = await ask({ question: 'gradient descent training', semanticIndex, apiKey: 'sk-test' });
    assert.equal(result.provider, 'local');
    assert.ok(result.warning.includes('network down'));
    assert.ok(result.answer.length > 10);
  } finally {
    global.fetch = originalFetch;
    semanticIndex.close();
  }
});
