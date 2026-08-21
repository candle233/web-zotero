'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend } = require('../src/recommend');

test('ranks items by overlapping title terms', () => {
  const items = [
    { key: 'a', title: 'Convex optimization methods', creators: [] },
    { key: 'b', title: 'Convex optimization theory', creators: [] },
    { key: 'c', title: 'Medieval poetry', creators: [] }
  ];
  const related = recommend(items, 'a', 2);
  assert.equal(related[0].key, 'b');
  assert.equal(related.length, 1);
});
