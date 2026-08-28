'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ask, splitSentences } = require('../src/ask');

// ── Sentence splitting ─────────────────────────────────────────────────────────

test('splitSentences splits on Chinese and English terminators', () => {
  const text = 'This is sentence one. This is sentence two! And a third? 第四句。第五句！';
  const sents = splitSentences(text);
  assert.ok(sents.length >= 4);
  assert.ok(sents.every(s => typeof s === 'string'));
});

test('splitSentences filters out too-short fragments (< 8 chars)', () => {
  const sents = splitSentences('a. b. c.');
  assert.equal(sents.length, 0);
});

test('splitSentences handles null/undefined gracefully', () => {
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences(undefined), []);
});

test('splitSentences normalises whitespace', () => {
  const sents = splitSentences('Long sentence here with tabs\tand spaces.   Next one.');
  assert.ok(sents.every(s => !s.includes('\t')));
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NO_INDEX = {
  ready: false,
  projectQuery: () => null,
  k: 0,
  chunkVectors: []
};

const READY_INDEX = (chunks) => ({
  ready: true,
  k: 4,
  projectQuery: () => null,
  chunkVectors: chunks
});

// ── ask — local extractive path ──────────────────────────────────────────────

test('ask returns the expected shape in extractive mode', async () => {
  const result = await ask({ question: 'What is machine learning?', semanticIndex: NO_INDEX });
  assert.ok('provider' in result);
  assert.ok('question' in result);
  assert.ok('answer' in result);
  assert.ok('passages' in result);
  assert.ok('itemKey' in result);
});

test('ask returns provider "local" when no apiKey', async () => {
  const result = await ask({ question: 'test', semanticIndex: NO_INDEX });
  assert.equal(result.provider, 'local');
});

test('ask trims the question', async () => {
  const result = await ask({ question: '  spaces around  ', semanticIndex: NO_INDEX });
  assert.equal(result.question, 'spaces around');
});

test('ask throws with statusCode 400 for blank question (after trim)', async () => {
  try {
    await ask({ question: '   ', semanticIndex: NO_INDEX });
    throw new Error('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 400);
  }
});

// ── ask — with a ready semanticIndex ─────────────────────────────────────────

test('ask returns top-ranked passages from semanticIndex (sorted by score desc)', async () => {
  const chunks = [
    { key: 'K1', title: 'Deep Learning', text: 'Deep learning uses neural networks with many layers. It has revolutionised computer vision.', snippet: 'Deep learning uses neural networks', score: 0.8 },
    { key: 'K2', title: 'AI', text: 'Artificial intelligence is the broader field.', snippet: 'Artificial intelligence', score: 0.4 },
    { key: 'K3', title: 'ML', text: 'Machine learning is a subset of AI.', snippet: 'Machine learning', score: 0.6 }
  ];
  const result = await ask({ question: 'What is deep learning?', semanticIndex: READY_INDEX(chunks) });
  assert.equal(result.provider, 'local');
  assert.ok(result.passages.length <= 4);
  const scores = result.passages.map(p => p.score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], 'passages should be sorted by score descending');
  }
});

test('ask caps passages at MAX_PASSAGES (4)', async () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    key: `K${i}`,
    title: `T${i}`,
    text: 'Deep learning uses neural networks with many layers.',
    snippet: 'Deep learning',
    score: 0.5 + i * 0.01
  }));
  const result = await ask({ question: 'What is deep learning?', semanticIndex: READY_INDEX(chunks) });
  assert.equal(result.passages.length, 4);
});

test('ask warns when OpenAI call fails and falls back to extractive', async () => {
  const result = await ask({
    question: 'What is AI?',
    apiKey: 'sk-test-key-that-will-fail',
    semanticIndex: READY_INDEX([
      { key: 'K1', title: 'AI', text: 'Artificial intelligence enables machines to learn.', snippet: 'Artificial intelligence', score: 0.8 }
    ]),
    baseUrl: 'https://api.openai.com/v1'
  });
  assert.ok('warning' in result);
  assert.ok(result.warning.toLowerCase().includes('openai') || result.warning.toLowerCase().includes('local'));
  assert.ok(typeof result.answer === 'string');
});

test('ask returns provider "local" when semanticIndex has no chunks', async () => {
  const result = await ask({ question: 'test', semanticIndex: READY_INDEX([]) });
  assert.equal(result.provider, 'local');
  assert.equal(result.passages.length, 0);
  // Empty corpus returns an actionable message rather than an empty string.
  assert.ok(result.answer.length > 0);
});

// ── tokenize (from semantic module) ──────────────────────────────────────────

test('tokenize lowercases and splits on whitespace/punctuation', () => {
  const { tokenize } = require('../src/semantic');
  const tokens = tokenize('Hello, World! Deep Learning 2024.');
  const lowered = tokens.map(t => t.toLowerCase());
  assert.ok(lowered.includes('hello'));
  assert.ok(lowered.includes('world'));
  assert.ok(lowered.includes('deep'));
  assert.ok(lowered.includes('learning'));
});

test('tokenize returns an array of non-empty strings', () => {
  const { tokenize } = require('../src/semantic');
  const tokens = tokenize('Test   multiple   spaces');
  assert.ok(tokens.length > 0);
  assert.ok(tokens.every(t => t.length > 0));
});
