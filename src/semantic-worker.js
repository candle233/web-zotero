'use strict';

/**
 * Worker thread for SemanticIndex.rebuildAsync(): reads the FTS corpus with
 * its own SQLite connection, runs the LSA math off the event loop, persists
 * through its own semantic-index connection, and reports a summary payload.
 */

const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { computeLsa, persistLsa } = require('./semantic');

const { dataDir, iterations } = workerData;

const fts = new DatabaseSync(path.join(dataDir, 'search-index.sqlite'), { readOnly: true });
fts.exec('PRAGMA busy_timeout = 5000');
const documents = fts.prepare('SELECT item_key, attachment_key, title, text FROM documents').all();
fts.close();

const semanticDb = new DatabaseSync(path.join(dataDir, 'semantic-index.sqlite'));
semanticDb.exec('PRAGMA busy_timeout = 5000');

const result = computeLsa(documents, { iterations });
if (!result.ready) {
  semanticDb.close();
  parentPort.postMessage({ started: true, ready: false, chunks: result.chunks, reason: result.reason });
} else {
  persistLsa(semanticDb, result);
  semanticDb.close();
  parentPort.postMessage({
    started: true,
    ready: true,
    chunks: result.totalChunks,
    items: result.itemVecs.size,
    terms: result.vocab,
    dimensions: result.k
  });
}
