'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WebAnnotationStore, normalizeRects } = require('../src/annotations-store');
const { UserStore } = require('../src/users');

// WebAnnotationStore joins the users table for author emails, so the
// UserStore schema must exist in the same data dir first.
function tempStores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-ann-'));
  new UserStore(dir).close();
  return { dir, annotations: new WebAnnotationStore(dir) };
}

const BASE = {
  itemKey: 'ITEM1', attachmentKey: 'FILE1', pageIndex: 2,
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]
};

test('normalizeRects clamps into [0,1] and rejects invalid input', () => {
  assert.deepEqual(
    normalizeRects([{ x: -0.5, y: 1.7, width: 0.5, height: 0.2 }]),
    [{ x: 0, y: 1, width: 0.5, height: 0.2 }]
  );
  assert.throws(() => normalizeRects([]), error => error.statusCode === 400);
  assert.throws(() => normalizeRects('nope'), error => error.statusCode === 400);
  assert.throws(() => normalizeRects([{ x: 'a', y: 0, width: 0, height: 0 }]), error => error.statusCode === 400);
  assert.throws(
    () => normalizeRects(Array.from({ length: 65 }, () => ({ x: 0, y: 0, width: 0.1, height: 0.1 }))),
    error => error.statusCode === 400
  );
});

test('create + list round-trip with normalized fields', () => {
  const { annotations } = tempStores();
  const created = annotations.create({ ...BASE, type: 'unknown', color: 'RED', comment: 'note', quote: 'q' });
  assert.equal(created.type, 'highlight', 'unknown type falls back to highlight');
  assert.equal(created.color, '#ffd400', 'invalid color falls back to default');
  assert.deepEqual(created.rects, BASE.rects);
  assert.equal(created.authorEmail, null);

  const listed = annotations.list({ itemKey: 'ITEM1' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.deepEqual(annotations.list({ itemKey: 'ITEM1', attachmentKey: 'OTHER' }), []);
  annotations.close();
});

test('create rejects bad pageIndex and missing keys', () => {
  const { annotations } = tempStores();
  assert.throws(() => annotations.create({ ...BASE, pageIndex: -1 }), error => error.statusCode === 400);
  assert.throws(() => annotations.create({ ...BASE, pageIndex: 1.5 }), error => error.statusCode === 400);
  assert.throws(() => annotations.create({ ...BASE, itemKey: '' }), error => error.statusCode === 400);
  assert.throws(() => annotations.list({}), error => error.statusCode === 400);
  annotations.close();
});

test('update and delete enforce author-or-owner ownership', () => {
  const { annotations } = tempStores();
  const author = { id: 7, role: 'editor' };
  const other = { id: 8, role: 'editor' };
  const owner = { id: 9, role: 'owner' };
  const created = annotations.create({ ...BASE, authorId: 7 });

  assert.equal(annotations.update(created.id, { color: '#ff6666' }, author).color, '#ff6666');
  assert.equal(annotations.update(created.id, { comment: 'x' }, owner).commentText, 'x');
  assert.throws(() => annotations.update(created.id, { color: '#ff6666' }, other), error => error.statusCode === 403);
  assert.throws(() => annotations.remove(created.id, other), error => error.statusCode === 403);

  assert.deepEqual(annotations.remove(created.id, author), { ok: true });
  assert.equal(annotations.list({ itemKey: 'ITEM1' }).length, 0);
  annotations.close();
});

test('annotations list is ordered by page then creation time', () => {
  const { annotations } = tempStores();
  annotations.create({ ...BASE, pageIndex: 4, rects: BASE.rects });
  annotations.create({ ...BASE, pageIndex: 1, rects: BASE.rects });
  annotations.create({ ...BASE, pageIndex: 4, pageLabel: 'iv', rects: BASE.rects });
  const listed = annotations.list({ itemKey: 'ITEM1' });
  assert.deepEqual(listed.map(row => row.pageIndex), [1, 4, 4]);
  assert.equal(listed[2].pageLabel, 'iv');
  annotations.close();
});
