'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { localSummary } = require('../src/local-ai');

test('local summary extracts repeated concepts as key points', () => {
  const text = `Optimization algorithms are central. The proposed optimization algorithm converges quickly. Optimization experiments compare three benchmark problems.`.repeat(3);
  const result = localSummary({ title: 'Optimization Test', authors: ['Ada Lovelace'], text });
  assert.equal(result.provider, 'local');
  assert.ok(result.summary.length > 30);
  assert.ok(result.keywords.includes('optimization'));
});

test('local summary rejects empty text', () => {
  assert.throws(() => localSummary({ title: '', authors: [], text: '' }), /No extracted text/u);
});
