'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventBus } = require('../src/events');
const { OfflineLibrary } = require('../src/offline');

test('EventBus replays buffered events newer than Last-Event-ID', () => {
  const bus = new EventBus();
  bus.publish('annotation', { action: 'created', id: 1 });
  const liveId = bus.publish('annotation', { action: 'created', id: 2 });

  // A fresh subscriber (no Last-Event-ID) receives only live events — initial
  // state comes from the REST endpoints instead of event history.
  const fresh = [];
  const off = bus.subscribe(event => { fresh.push(event.payload.id); return true; });
  bus.publish('annotation', { action: 'created', id: 3 });
  assert.deepEqual(fresh, [3]);
  off();

  // A reconnecting client replays everything newer than its last seen id.
  const replayed = [];
  bus.subscribe(
    event => { replayed.push(event.payload.id); return true; },
    { lastEventId: 0 }
  );
  bus.publish('annotation', { action: 'created', id: 4 });
  assert.deepEqual(replayed, [1, 2, 3, 4]);
});

test('OfflineLibrary.remove deletes one copy or the whole item folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-offline-'));
  const library = new OfflineLibrary(dir);
  fs.mkdirSync(path.join(dir, 'offline', 'ITEM1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'offline', 'ITEM1', 'ATT1-paper.pdf'), 'a');
  fs.writeFileSync(path.join(dir, 'offline', 'ITEM1', 'ATT2-thesis.pdf'), 'b');

  const one = await library.remove('ITEM1', 'ATT1');
  assert.equal(one.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'offline', 'ITEM1', 'ATT1-paper.pdf')), false);
  assert.equal(fs.existsSync(path.join(dir, 'offline', 'ITEM1')), true);

  const all = await library.remove('ITEM1');
  assert.equal(all.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'offline', 'ITEM1')), false);
  // basename() neutralizes traversal: "../escape" stays inside the offline root.
  const sneaky = await library.remove('../escape');
  assert.equal(sneaky.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'offline')), true);
});
