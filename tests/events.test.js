'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EventBus } = require('../src/events');
const { WebStore } = require('../src/web-store');

test('EventBus delivers events to subscribers with incrementing ids', () => {
  const bus = new EventBus();
  const received = [];
  bus.subscribe(event => {
    received.push(event);
    return true;
  });
  const idA = bus.publish('annotation', { action: 'created', id: 1 });
  const idB = bus.publish('annotation', { action: 'deleted', id: 1 });
  assert.equal(idB, idA + 1);
  assert.deepEqual(received.map(event => event.payload.action), ['created', 'deleted']);
  assert.ok(received.every(event => event.type === 'annotation'));
});

test('EventBus removes dead subscribers automatically', () => {
  const bus = new EventBus();
  let calls = 0;
  bus.subscribe(() => {
    calls += 1;
    return false; // connection closed
  });
  bus.subscribe(() => {
    throw new Error('socket hang up');
  });
  bus.publish('note', {});
  assert.equal(calls, 1);
  assert.equal(bus.subscriberCount, 0);
});

test('EventBus unsubscribe stops delivery and closeAll invokes closers', () => {
  const bus = new EventBus();
  let closed = false;
  const received = [];
  const unsubscribe = bus.subscribe(event => {
    received.push(event);
    return true;
  }, { close: () => { closed = true; } });
  unsubscribe();
  bus.publish('annotation', {});
  assert.equal(received.length, 0);
  assert.equal(bus.subscriberCount, 0);

  const closer2 = { called: false };
  bus.subscribe(() => true, { close: () => { closer2.called = true; } });
  bus.closeAll();
  assert.equal(closed, false, 'already-unsubscribed closer must not run');
  assert.equal(closer2.called, true);
  assert.equal(bus.subscriberCount, 0);
});

test('WebStore.mentions finds exact [[title]] links and ignores plain occurrences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-mentions-'));
  const store = new WebStore(dir);
  store.saveNote('A', 'See [[Convex Optimization]] for details.');
  store.saveNote('B', '<p>Related: [[Convex Optimization]] chapter 2</p>', '<p>Related: [[Convex Optimization]] chapter 2</p>');
  store.saveNote('C', 'I read Convex Optimization but no wiki link here.');
  store.saveNote('D', 'Wildcards % and _ like [[Convex Optimization]]');

  const mentions = store.mentions('Convex Optimization');
  assert.deepEqual(mentions.map(entry => entry.itemKey).sort(), ['A', 'B', 'D']);
  assert.deepEqual(store.mentions('Nothing'), []);
  store.database.close();
});
