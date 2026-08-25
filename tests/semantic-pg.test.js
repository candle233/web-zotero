'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PgSemanticIndex, localEmbed, cosineSimilarity } = require('../src/semantic-pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

test('localEmbed produces normalized fixed-dimension vectors', () => {
  const vec = localEmbed('machine learning neural networks transformers', 64);
  assert.equal(vec.length, 64);
  let norm = 0;
  for (const v of vec) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 1e-4);
});

test('cosineSimilarity calculates geometric cosine accurately', () => {
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  const c = [0, 1, 0];
  assert.equal(cosineSimilarity(a, b), 1.0);
  assert.equal(cosineSimilarity(a, c), 0.0);
});

test('PgSemanticIndex document indexing and search lifecycle when DATABASE_URL is set', { skip: !DATABASE_URL }, async () => {
  const pgSemantic = new PgSemanticIndex(DATABASE_URL, { dimensions: 64 });
  await pgSemantic.init();

  const ts = Date.now();
  const doc1Key = `SEM_DOC1_${ts}`;
  const doc2Key = `SEM_DOC2_${ts}`;

  try {
    // 1. Index document 1 (Deep Learning)
    const count1 = await pgSemantic.indexDocument(
      doc1Key,
      'ATT1',
      'Deep Learning with Convolutional Networks',
      'Deep neural networks and convolutional layers have revolutionized image classification and computer vision.'
    );
    assert.ok(count1 >= 1);

    // 2. Index document 2 (Quantum Mechanics)
    const count2 = await pgSemantic.indexDocument(
      doc2Key,
      'ATT2',
      'Quantum Entanglement and Superposition',
      'Quantum entanglement and wave function collapse describe non-local correlations in quantum physics.'
    );
    assert.ok(count2 >= 1);

    // 3. Search for neural networks -> Doc 1 ranks first
    const searchResults = await pgSemantic.search('neural networks vision', 5);
    assert.ok(searchResults.length >= 1);
    assert.equal(searchResults[0].itemKey, doc1Key);
    assert.ok(searchResults[0].score > 0.1);

    // 4. Search for quantum -> Doc 2 ranks first
    const quantumResults = await pgSemantic.search('quantum physics entanglement', 5);
    assert.ok(quantumResults.length >= 1);
    assert.equal(quantumResults[0].itemKey, doc2Key);

    // 5. Chunks retrieval
    const chunks = await pgSemantic.chunksFor(doc1Key);
    assert.equal(chunks.length, count1);
    assert.equal(chunks[0].itemKey, doc1Key);

    // 6. Status
    const status = await pgSemantic.status();
    assert.equal(status.ready, true);
    assert.ok(status.chunks >= 2);

  } finally {
    // Cleanup test records
    await pgSemantic.pool.query('DELETE FROM document_embeddings WHERE item_key IN ($1, $2)', [doc1Key, doc2Key]).catch(() => {});
    await pgSemantic.close();
  }
});
