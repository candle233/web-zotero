'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { maskConnectionString, isPostgresReachable, pickDatabaseUrl } = require('../src/detect-postgres');

test('maskConnectionString hides passwords and leaves the rest intact', () => {
  assert.equal(
    maskConnectionString('postgresql://user:secret@127.0.0.1:5432/db'),
    'postgresql://user:****@127.0.0.1:5432/db'
  );
  // No password present — pass through unchanged.
  assert.equal(
    maskConnectionString('postgres://localhost/foo'),
    'postgres://localhost/foo'
  );
  // Empty / non-string input.
  assert.equal(maskConnectionString(''), '');
  assert.equal(maskConnectionString(undefined), '');
});

test('isPostgresReachable returns false on unreachable host', async () => {
  const t0 = Date.now();
  const ok = await isPostgresReachable('postgresql://nobody:nobody@127.0.0.1:1/nobody', 400);
  const elapsed = Date.now() - t0;
  assert.equal(ok, false, 'unreachable port should be reported as not reachable');
  // The probe must time out quickly — it must not hang on a TCP open forever.
  assert.ok(elapsed < 5000, `probe took too long (${elapsed}ms); check timeoutMs handling`);
});

test('isPostgresReachable returns false on malformed DSN without throwing', async () => {
  assert.equal(await isPostgresReachable('not a dsn', 200), false);
  assert.equal(await isPostgresReachable('', 200), false);
  assert.equal(await isPostgresReachable(null, 200), false);
});

test('pickDatabaseUrl honors explicit DATABASE_URL', async () => {
  const result = await pickDatabaseUrl('postgresql://u:p@h:5432/d');
  assert.equal(result.url, 'postgresql://u:p@h:5432/d');
  assert.equal(result.explicit, true);
});

test('pickDatabaseUrl auto-detects a non-listening port (returns null)', async () => {
  // Point at a guaranteed-closed port with a short probe budget.
  const savedEnv = { ...process.env };
  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = '1';
  process.env.PGUSER = 'noone';
  process.env.PGPASSWORD = 'noone';
  process.env.PGDATABASE = 'nodb';
  try {
    const result = await pickDatabaseUrl(undefined);
    assert.equal(result.url, null, 'closed port should yield null url');
    assert.equal(result.explicit, false);
  } finally {
    process.env = savedEnv;
  }
});

test('pickDatabaseUrl prefers an explicit URL over env', async () => {
  const savedEnv = { ...process.env };
  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = '1';
  try {
    const result = await pickDatabaseUrl('postgresql://override:1/db');
    assert.equal(result.url, 'postgresql://override:1/db');
    assert.equal(result.explicit, true);
  } finally {
    process.env = savedEnv;
  }
});
