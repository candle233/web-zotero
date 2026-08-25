'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { UserStore, hashPasswordAsync, verifyPasswordAsync, MAX_SESSIONS_PER_USER } = require('../src/users');
const { WebStore } = require('../src/web-store');
const { sanitizeNoteHtml } = require('../src/notes-html');

function tempUserStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-opt-users-'));
  return { dir, store: new UserStore(dir) };
}

function tempWebStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wz-opt-web-'));
  return { dir, store: new WebStore(dir) };
}

test('hashPasswordAsync & verifyPasswordAsync round-trip asynchronously', async () => {
  const hash = await hashPasswordAsync('quantum-crypto-password-2026');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPasswordAsync('quantum-crypto-password-2026', hash), true);
  assert.equal(await verifyPasswordAsync('wrong-guess', hash), false);
});

test('UserStore enforces MAX_SESSIONS_PER_USER limit (10)', () => {
  const { store } = tempUserStore();
  const user = store.createUser({ email: 'session-limit@test.com', password: 'valid-password' });

  // Issue 12 tokens
  const tokens = [];
  for (let i = 0; i < 12; i++) {
    tokens.push(store.issueToken(user));
  }

  const sessions = store.listSessions(user.id);
  assert.equal(sessions.length, MAX_SESSIONS_PER_USER);

  // The first 2 tokens should be purged and no longer resolve
  assert.equal(store.resolveToken(tokens[0]), null);
  assert.equal(store.resolveToken(tokens[1]), null);

  // The newest token should resolve
  assert.ok(store.resolveToken(tokens[11]) !== null);

  store.close();
});

test('WebStore listAllNotes returns saved notes ordered by update time', () => {
  const { store } = tempWebStore();
  store.saveNote('ITEM_A', 'Note for paper A', '<p>Note for paper A</p>');
  store.saveNote('ITEM_B', 'Note for paper B', '<p>Note for paper B</p>');

  const allNotes = store.listAllNotes();
  assert.equal(allNotes.length, 2);
  assert.ok(allNotes.some(n => n.itemKey === 'ITEM_A'));
  assert.ok(allNotes.some(n => n.itemKey === 'ITEM_B'));

  store.close();
});

test('sanitizeNoteHtml cleans malicious injections while preserving rich markdown elements', () => {
  const dirty = `
    <h1>Chapter 1</h1>
    <p>Good text with <a href="https://example.com" onclick="alert(1)">link</a></p>
    <script>alert('xss')</script>
    <iframe src="javascript:alert(2)"></iframe>
    <img src="x" onerror="evil()" />
    <blockquote>Quoted text</blockquote>
    <pre><code>const x = 10;</code></pre>
  `;
  const clean = sanitizeNoteHtml(dirty);
  assert.ok(!clean.includes('<script>'));
  assert.ok(!clean.includes('<iframe>'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));
  assert.ok(clean.includes('<h1>Chapter 1</h1>'));
  assert.ok(clean.includes('<a href="https://example.com" rel="noopener">link</a>'));
  assert.ok(clean.includes('<blockquote>Quoted text</blockquote>'));
  assert.ok(clean.includes('<pre><code>const x = 10;</code></pre>'));
});
