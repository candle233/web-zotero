'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { UserStore, hashPassword, verifyPassword } = require('../src/users');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-zotero-users-'));
  return { dir, store: new UserStore(dir) };
}

test('hashPassword/verifyPassword round-trip and reject wrong password', () => {
  const stored = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('correct horse battery', 'not-a-hash'), false);
});

test('createUser enforces email, password length and role', () => {
  const { store } = tempStore();
  assert.throws(() => store.createUser({ email: 'nope', password: 'longenough' }), error => error.statusCode === 400);
  assert.throws(() => store.createUser({ email: 'a@b.co', password: 'short' }), error => error.statusCode === 400);
  assert.throws(() => store.createUser({ email: 'a@b.co', password: 'longenough', role: 'admin' }), error => error.statusCode === 400);
  store.close();
});

test('first account becomes owner regardless of requested role', () => {
  const { store } = tempStore();
  const owner = store.createUser({ email: 'Owner@Example.com', password: 'longenough', role: 'viewer' });
  assert.equal(owner.role, 'owner');
  assert.equal(owner.email, 'owner@example.com');
  const member = store.createUser({ email: 'm@example.com', password: 'longenough', role: 'viewer' });
  assert.equal(member.role, 'viewer');
  store.close();
});

test('duplicate email is rejected with 409', () => {
  const { store } = tempStore();
  store.createUser({ email: 'a@b.co', password: 'longenough' });
  assert.throws(() => store.createUser({ email: 'A@B.CO', password: 'longenough' }), error => error.statusCode === 409);
  store.close();
});

test('authenticate issues working, expiring and revocable tokens', async () => {
  const { store } = tempStore();
  const user = store.createUser({ email: 'u@b.co', password: 'longenough' });
  assert.throws(() => store.authenticate('u@b.co', 'bad'), error => error.statusCode === 401);

  const token = store.issueToken(user);
  const resolved = store.resolveToken(token);
  assert.equal(resolved.email, 'u@b.co');
  assert.equal(resolved.role, 'owner');

  store.revokeToken(token);
  assert.equal(store.resolveToken(token), null);

  const shortLived = store.issueToken(user, { ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.resolveToken(shortLived), null);
  store.close();
});

test('role updates protect the last owner', () => {
  const { store } = tempStore();
  const owner = store.createUser({ email: 'o@b.co', password: 'longenough' });
  const editor = store.createUser({ email: 'e@b.co', password: 'longenough', role: 'editor' });
  assert.throws(() => store.updateUser(owner.id, { role: 'editor' }), error => error.statusCode === 409);
  assert.equal(store.updateUser(editor.id, { role: 'viewer' }).role, 'viewer');
  assert.equal(store.updateUser(editor.id, { displayName: 'Editor One' }).displayName, 'Editor One');
  store.close();
});

test('soft-deleted users cannot authenticate and last owner cannot be deleted', () => {
  const { store } = tempStore();
  const owner = store.createUser({ email: 'o@b.co', password: 'longenough' });
  const member = store.createUser({ email: 'm@b.co', password: 'longenough' });
  assert.throws(() => store.deleteUser(owner.id), error => error.statusCode === 409);

  store.deleteUser(member.id);
  assert.throws(() => store.authenticate('m@b.co', 'longenough'), error => error.statusCode === 401);
  assert.equal(store.count(), 1);
  store.close();
});

test('deleting a user revokes their sessions', () => {
  const { store } = tempStore();
  const owner = store.createUser({ email: 'o@b.co', password: 'longenough' });
  const member = store.createUser({ email: 'm@b.co', password: 'longenough' });
  const token = store.issueToken(store.authenticate('m@b.co', 'longenough'));
  assert.ok(store.resolveToken(token));
  store.deleteUser(member.id);
  assert.equal(store.resolveToken(token), null);
  assert.ok(store.resolveToken(store.issueToken(owner)));
  store.close();
});
