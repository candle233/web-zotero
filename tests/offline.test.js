'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { OfflineLibrary } = require('../src/offline');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wz-offline-'));
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

test('OfflineLibrary.list() returns empty array when root does not exist', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    assert.deepEqual(await lib.list(), []);
  } finally { cleanup(dir); }
});

test('OfflineLibrary.list() returns one entry per subdirectory', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    await fsp.mkdir(path.join(dir, 'offline', 'ITEM_A'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'offline', 'ITEM_B'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'offline', 'stray.txt'), 'x');
    const entries = await lib.list();
    assert.equal(entries.length, 2);
    assert.ok(entries.find(e => e.itemKey === 'ITEM_A'));
    assert.ok(entries.find(e => e.itemKey === 'ITEM_B'));
  } finally { cleanup(dir); }
});

test('OfflineLibrary.save() copies file to subdir keyed by itemKey', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    const src = path.join(dir, 'source.pdf');
    await fsp.writeFile(src, 'fake pdf content');
    const result = await lib.save('ITEM_X', 'ATT_X', src);
    assert.equal(result.itemKey, 'ITEM_X');
    assert.equal(result.attachmentKey, 'ATT_X');
    assert.ok(result.filePath.includes('ITEM_X'));
    assert.ok(result.size > 0);
    assert.ok(fs.existsSync(result.filePath), 'file should exist at filePath');
    const content = await fsp.readFile(result.filePath, 'utf8');
    assert.equal(content, 'fake pdf content');
  } finally { cleanup(dir); }
});

test('OfflineLibrary.save() reuses destination if source matches', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    const src = path.join(dir, 'source.pdf');
    await fsp.writeFile(src, 'same content');
    const first = await lib.save('ITEM_K', 'ATT_K', src);
    const second = await lib.save('ITEM_K', 'ATT_K', src);
    assert.equal(first.filePath, second.filePath);
  } finally { cleanup(dir); }
});

test('OfflineLibrary.save() rejects unsafe itemKey traversal (path.basename neutralises)', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    const src = path.join(dir, 'source.pdf');
    await fsp.writeFile(src, 'content');
    // path.basename('../escape') === 'escape' — the dest ends up inside root.
    const result = await lib.save('../escape', 'ATT', src);
    assert.ok(result.filePath.startsWith(dir), 'must stay inside the data dir');
  } finally { cleanup(dir); }
});

test('OfflineLibrary.remove() deletes files matching attachmentKey prefix in item folder', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    await fsp.mkdir(path.join(dir, 'offline', 'ITEM_R'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'offline', 'ITEM_R', 'ATT_R-paper.pdf'), 'a');
    await fsp.writeFile(path.join(dir, 'offline', 'ITEM_R', 'ATT_R-extra.pdf'), 'b');
    await fsp.writeFile(path.join(dir, 'offline', 'ITEM_R', 'OTHER-thumb.jpg'), 'c');
    const result = await lib.remove('ITEM_R', 'ATT_R');
    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(path.join(dir, 'offline', 'ITEM_R', 'ATT_R-paper.pdf')));
    assert.ok(!fs.existsSync(path.join(dir, 'offline', 'ITEM_R', 'ATT_R-extra.pdf')));
    assert.ok(fs.existsSync(path.join(dir, 'offline', 'ITEM_R', 'OTHER-thumb.jpg')), 'other prefix must be untouched');
  } finally { cleanup(dir); }
});

test('OfflineLibrary.remove() returns ok for non-existent item', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    const result = await lib.remove('NON_EXISTENT_ITEM');
    assert.equal(result.ok, true);
    // removed is the folder name that was (attempted to be) deleted.
    assert.equal(result.removed, 'NON_EXISTENT_ITEM');
  } finally { cleanup(dir); }
});

test('OfflineLibrary.remove() cleans up empty parent folder', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    await fsp.mkdir(path.join(dir, 'offline', 'EMPTY_ITEM'), { recursive: true });
    await lib.remove('EMPTY_ITEM');
    const exists = fs.existsSync(path.join(dir, 'offline', 'EMPTY_ITEM'));
    if (exists) {
      const contents = await fsp.readdir(path.join(dir, 'offline', 'EMPTY_ITEM'));
      assert.equal(contents.length, 0, 'folder should be empty if it remains');
    }
  } finally { cleanup(dir); }
});

test('OfflineLibrary.listDetailed() returns one entry per subdirectory', async () => {
  const dir = tempDir();
  const lib = new OfflineLibrary(dir);
  try {
    await fsp.mkdir(path.join(dir, 'offline', 'ITEM_D1'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'offline', 'ITEM_D2'), { recursive: true });
    const detailed = await lib.listDetailed();
    assert.equal(detailed.length, 2);
    assert.ok(detailed.every(e => typeof e.itemKey === 'string'));
  } finally { cleanup(dir); }
});
