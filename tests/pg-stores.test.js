const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PgWebStore } = require('../src/web-store-pg');
const { PgWebAnnotationStore } = require('../src/annotations-store-pg');
const { PgUserStore } = require('../src/users-pg');
const { hashPasswordAsync, verifyPasswordAsync } = require('../src/users');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

test('PgWebStore & PgWebAnnotationStore round-trip when DATABASE_URL is set', { skip: !DATABASE_URL }, async () => {
  const webStore = new PgWebStore(DATABASE_URL);
  const annotationStore = new PgWebAnnotationStore(DATABASE_URL);
  const userStore = new PgUserStore(DATABASE_URL);

  const testKey = `TEST_ITEM_${Date.now()}`;
  const testAttachment = `TEST_ATT_${Date.now()}`;

  try {
    // 1. Note saving and versioning
    const note1 = await webStore.saveNote(testKey, 'First draft', '<p>First draft</p>');
    assert.equal(note1.version, 1);
    assert.equal(note1.content, 'First draft');

    const fetched1 = await webStore.getNote(testKey);
    assert.equal(fetched1.content, 'First draft');
    assert.equal(fetched1.version, 1);

    // Save v2
    const note2 = await webStore.saveNote(testKey, 'Second draft', '<p>Second draft</p>', 1);
    assert.equal(note2.version, 2);

    // Stale version save fails with 409
    await assert.rejects(
      async () => webStore.saveNote(testKey, 'Stale draft', null, 1),
      err => err.statusCode === 409 && err.currentNote.version === 2
    );

    const versions = await webStore.listNoteVersions(testKey);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].version, 1);

    // 2. Reading progress & stats
    const progress = await webStore.saveProgress(testKey, 75.5);
    assert.equal(progress.scrollPercent, 75.5);
    const fetchedProgress = await webStore.getProgress(testKey);
    assert.equal(fetchedProgress.scrollPercent, 75.5);

    const stats = await webStore.readingStats();
    assert.ok(stats.started >= 1);

    // 3. Web imported items
    const importRes = await webStore.saveImported([{
      key: `${testKey}_IMP`,
      itemType: 'journalArticle',
      title: 'Postgres Test Paper',
      creators: [{ firstName: 'John', lastName: 'Postgres' }],
      fields: { DOI: '10.1234/pg-test' }
    }]);
    assert.equal(importRes.ok, true);

    const imported = await webStore.getImported(`${testKey}_IMP`);
    assert.equal(imported.title, 'Postgres Test Paper');
    assert.equal(imported.fields.DOI, '10.1234/pg-test');

    const importedList = await webStore.listImported();
    assert.ok(importedList.some(item => item.key === `${testKey}_IMP`));

    // 4. AI summary cache
    await webStore.cacheSummary(testKey, 'test-provider', { summary: 'A great paper' });
    const cachedSummary = await webStore.getCachedSummary(testKey);
    assert.equal(cachedSummary.provider, 'test-provider');
    assert.equal(cachedSummary.summary, 'A great paper');

    // 5. Formula history
    const formula = await webStore.saveFormula('\\int_0^1 x dx = \\frac{1}{2}', testKey);
    assert.ok(formula.id > 0);
    const formulas = await webStore.listFormulas();
    assert.ok(formulas.some(f => f.id === formula.id));
    await webStore.deleteFormula(formula.id);

    // 6. Mentions / backlinks
    await webStore.saveNote(`${testKey}_LINK`, `Refers to [[${testKey}]]`);
    const mentions = await webStore.mentions(testKey);
    assert.ok(mentions.some(m => m.itemKey === `${testKey}_LINK`));
    await webStore.deleteNote(`${testKey}_LINK`);

    // 7. Web annotations
    const ann = await annotationStore.create({
      itemKey: testKey,
      attachmentKey: testAttachment,
      pageIndex: 0,
      type: 'highlight',
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
      color: '#ffcc00',
      comment: 'Check this out',
      quote: 'Important text'
    });
    assert.ok(ann.id > 0);
    assert.equal(ann.commentText, 'Check this out');
    assert.equal(ann.color, '#ffcc00');

    const annList = await annotationStore.list({ itemKey: testKey });
    assert.equal(annList.length, 1);
    assert.equal(annList[0].id, ann.id);

    const updatedAnn = await annotationStore.update(ann.id, { comment: 'Updated comment' });
    assert.equal(updatedAnn.commentText, 'Updated comment');

    const deleteRes = await annotationStore.remove(ann.id);
    assert.equal(deleteRes.ok, true);

    const afterDelete = await annotationStore.list({ itemKey: testKey });
    assert.equal(afterDelete.length, 0);

  } finally {
    // Cleanup test data
    await webStore.deleteNote(testKey).catch(() => {});
    await webStore.deleteImported(`${testKey}_IMP`).catch(() => {});
    await webStore.close();
    await annotationStore.close();
    await userStore.close();
  }
});


test('PgUserStore full surface when DATABASE_URL is set', { skip: !DATABASE_URL }, async () => {
  const userStore = new PgUserStore(DATABASE_URL);
  const testEmail = `pg-user-${Date.now()}@example.com`;

  try {
    const user = await userStore.createUser({ email: testEmail, password: 'long-enough-1' });
    assert.equal(user.email, testEmail);
    assert.ok(['owner','editor'].includes(user.role), `role should be owner or editor, got ${user.role}`);
    assert.ok((await userStore.count()) >= 1);
    const listed = await userStore.listUsers();
    assert.ok(listed.some(u => u.email === testEmail));

    const authed = await userStore.authenticate(testEmail, 'long-enough-1');
    assert.equal(authed.email, testEmail);
    await assert.rejects(async () => userStore.authenticate(testEmail, 'wrong-password'),
      error => error.statusCode === 401);

    const issued = await userStore.issueToken(user);
    assert.ok(issued);
    const cp = await userStore.changePassword(user.id, 'long-enough-1', 'new-password-2');
    assert.equal(cp.ok, true);
    assert.equal(await userStore.resolveToken(issued), null);
    const authed2 = await userStore.authenticate(testEmail, 'new-password-2');
    assert.equal(authed2.id, user.id);

    const newToken = await userStore.issueToken(user);
    const { hashToken } = require('../src/users');
    const sessions = await userStore.listSessions(user.id, hashToken(newToken));
    assert.ok(sessions.length >= 1, true);
    assert.equal(sessions.filter(s => s.current).length, 1, 'exactly one current session');

    const victim = await userStore.issueToken(user);
    const victimRef = (await userStore.listSessions(user.id)).find(s => !s.current).ref;
    assert.ok(victimRef);
    await userStore.revokeSession(user.id, victimRef);
    assert.equal(await userStore.resolveToken(victim), null);

    const updated = await userStore.updateUser(user.id, { displayName: 'Test User' });
    assert.equal(updated.displayName, 'Test User');

    const del = await userStore.deleteUser(user.id);
    assert.equal(del.ok, true);
    await assert.rejects(async () => userStore.authenticate(testEmail, 'new-password-2'),
      error => error.statusCode === 401);
  } finally {
    await userStore.pool.query("DELETE FROM users WHERE email LIKE $1", [testEmail]).catch(() => {});
    await userStore.close();
  }
});

test('PgWebStore.getNote returns default for missing key', { skip: !DATABASE_URL }, async () => {
  const webStore = new PgWebStore(DATABASE_URL);
  try {
    const result = await webStore.getNote(`MISSING_KEY_${Date.now()}`);
    assert.ok(result.itemKey.startsWith('MISSING_KEY_'));
    assert.equal(result.content, '');
    assert.equal(result.html, null);
    assert.equal(result.updatedAt, null);
    assert.equal(result.version, 0);
  } finally { await webStore.close(); }
});

test('hashPasswordAsync / verifyPasswordAsync are usable', async () => {
  const hash = await hashPasswordAsync('hello-async-pw');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPasswordAsync('hello-async-pw', hash), true);
  assert.equal(await verifyPasswordAsync('wrong', hash), false);
});
