'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ZoteroDatabase } = require('../src/zotero-db');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wz-zoterodb-'));

function makeFakeZotero(rootDir) {
  // Create a Zotero-style layout: rootDir/zotero.sqlite (real SQLite) + rootDir/storage/
  const dbPath = path.join(rootDir, 'zotero.sqlite');
  const storage = path.join(rootDir, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  // Create a real SQLite file so the constructor can open it (read-only).
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT, dateAdded TEXT, dateModified TEXT, itemTypeID INTEGER);
    CREATE TABLE itemTypes(typeID INTEGER PRIMARY KEY, typeName TEXT);
    CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER);
    CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE fieldsCombined(fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemCreators(itemID INTEGER, creatorID INTEGER, orderIndex INTEGER);
    CREATE TABLE creators(creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
    CREATE TABLE itemAttachments(itemID INTEGER, contentType TEXT, path TEXT);
    CREATE TABLE itemNotes(itemID INTEGER, parentItemID INTEGER);
    CREATE TABLE itemAnnotations(itemID INTEGER, parentItemID INTEGER, type TEXT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, authorName TEXT);
    CREATE TABLE itemTags(itemID INTEGER, tagID INTEGER);
    CREATE TABLE tags(tagID INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE deletedItems(itemID INTEGER);
    CREATE TABLE collections(collectionID INTEGER, collectionName TEXT, parentCollectionID INTEGER);
    CREATE TABLE collectionItems(itemID INTEGER, collectionID INTEGER);
    INSERT INTO collections(collectionID, collectionName) VALUES (1, 'Default');
  `);
  db.close();
  return { dbPath, storage };
}

test('ZoteroDatabase uses explicit databasePath and storagePath', () => {
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath, storagePath: storage });
  assert.equal(db.databasePath, dbPath);
  assert.equal(db.storagePath, storage);
});

test('ZoteroDatabase falls back to derived storage sibling when storagePath is omitted', () => {
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath });
  assert.equal(db.storagePath, storage, 'storage should be derived sibling of DB path');
});

test('ZoteroDatabase throws with actionable error when DB does not exist', () => {
  try {
    new ZoteroDatabase({ databasePath: path.join(tempDir(), 'missing.sqlite'), storagePath: tempDir() });
    throw new Error('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('Zotero database not found'));
    assert.ok(err.message.includes('ZOTERO_DATABASE'));
  }
});

test('ZoteroDatabase throws when explicit databasePath is empty string', () => {
  // Empty string is falsy → falls through to the "file does not exist" guard.
  try {
    new ZoteroDatabase({ databasePath: '', storagePath: tempDir() });
    throw new Error('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('Zotero database not found'));
  }
});

test('ZoteroDatabase throw message mentions ZOTERO_DATABASE and ZOTERO_STORAGE', () => {
  try {
    new ZoteroDatabase({ databasePath: '/no/where/file', storagePath: '/no/where/dir' });
    throw new Error('should have thrown');
  } catch (err) {
    assert.match(err.message, /ZOTERO_DATABASE/);
    assert.match(err.message, /ZOTERO_STORAGE/);
  }
});

test('ZoteroDatabase constructor without args falls back to ~/Zotero/zotero.sqlite', () => {
  // We can't predict the user's actual path; just confirm it doesn't throw on a
  // well-known Zotero install OR throws the "not found" error (not a crash).
  let db;
  try {
    db = new ZoteroDatabase();
    assert.ok(db.databasePath.includes('Zotero'));
  } catch (err) {
    assert.match(err.message, /Zotero database not found/);
  }
});

test('ZoteroDatabase with explicit storagePath undefined derives it from DB sibling', () => {
  // (This test was previously named "...null uses provided..." — renamed because
  // passing null falls through to the default-arg (undefined) branch, which
  // derives the sibling path. There's no way to force storagePath to be null
  // when it's a default parameter.)
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath, storagePath: undefined });
  assert.equal(db.storagePath, storage);
});

test('ZoteroDatabase with undefined storagePath derives it from DB sibling', () => {
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath, storagePath: undefined });
  assert.equal(db.storagePath, storage);
});

test('ZoteroDatabase.pragma busy_timeout is set (handles Zotero write locks)', () => {
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath, storagePath: storage });
  // PRAGMA read should succeed; no throw.
  const result = db.database.prepare('PRAGMA busy_timeout').get();
  assert.ok(result);
});

test('ZoteroDatabase opens the DB (PRAGMA query returns a row)', () => {
  const dir = tempDir();
  const { dbPath, storage } = makeFakeZotero(dir);
  const db = new ZoteroDatabase({ databasePath: dbPath, storagePath: storage });
  // PRAGMA query proves the read-only connection was opened successfully.
  const result = db.database.prepare('PRAGMA busy_timeout').get();
  assert.ok(result, 'PRAGMA must return a row');
  assert.equal(db.databasePath, dbPath);
  assert.equal(db.storagePath, storage);
});
