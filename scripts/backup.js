'use strict';

/**
 * Backup the web-layer data stores.
 *
 *   node scripts/backup.js [--out <dir>] [--keep <n>]
 *
 * - SQLite mode: VACUUM INTO creates a consistent snapshot of every
 *   data/*.sqlite store (web-data, search-index, semantic-index), then
 *   checkpoints the WAL so the live files stay small.
 * - PostgreSQL mode (DATABASE_URL set): shells out to pg_dump when available.
 * - --keep N prunes old backups, keeping the newest N per store (default 7).
 *
 * Exit code 0 = all stores backed up; 1 = at least one failure.
 */

require('dotenv').config();
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const STORES = ['web-data.sqlite', 'search-index.sqlite', 'semantic-index.sqlite'];

function parseArgs(argv) {
  const args = { out: path.join(DATA_DIR, 'backups'), keep: 7 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--keep') args.keep = Number(argv[++i]) || 7;
  }
  return args;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function backupSqlite(storeFile, outDir) {
  const src = path.join(DATA_DIR, storeFile);
  if (!fs.existsSync(src)) return { store: storeFile, skipped: true };
  const { DatabaseSync } = require('node:sqlite');
  const dest = path.join(outDir, `${storeFile.replace(/\.sqlite$/, '')}-${stamp()}.sqlite`);
  // VACUUM INTO produces a compacted, consistent snapshot without stopping readers.
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  // Checkpoint the WAL so the live store's -wal file does not grow unbounded.
  try {
    const wal = new DatabaseSync(src);
    wal.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    wal.close();
  } catch (err) {
    console.warn(`  WAL checkpoint failed for ${storeFile}: ${err.message}`);
  }
  const stat = await fsp.stat(dest);
  return { store: storeFile, dest, size: stat.size };
}

async function backupPostgres(outDir) {
  const url = process.env.DATABASE_URL;
  if (!url) return { store: 'postgresql', skipped: true };
  const dest = path.join(outDir, `web-zotero-pg-${stamp()}.sql`);
  try {
    await execFileAsync('pg_dump', ['--no-owner', '--no-privileges', '-f', dest, url], { timeout: 120000 });
    const stat = await fsp.stat(dest);
    return { store: 'postgresql', dest, size: stat.size };
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('  pg_dump not found on PATH — skipping PG backup.');
      return { store: 'postgresql', skipped: true, reason: 'pg_dump missing' };
    }
    throw error;
  }
}

async function pruneOld(outDir, keep) {
  const groups = new Map();
  for (const file of await fsp.readdir(outDir)) {
    const match = /^(.+?)-\d{4}-\d{2}-\d{2}T/.exec(file);
    if (!match) continue;
    const group = match[1];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }
  let pruned = 0;
  for (const [, files] of groups) {
    files.sort().reverse();
    for (const file of files.slice(keep)) {
      await fsp.rm(path.join(outDir, file), { force: true });
      pruned += 1;
    }
  }
  return pruned;
}

async function main() {
  const args = parseArgs(process.argv);
  await fsp.mkdir(args.out, { recursive: true });
  console.log(`Backing up web-layer stores from ${DATA_DIR} → ${args.out}`);

  const results = [];
  let failures = 0;

  for (const store of STORES) {
    try {
      const result = await backupSqlite(store, args.out);
      if (result.skipped) console.log(`  ${store}: skipped (not present)`);
      else console.log(`  ${store}: ${(result.size / 1024 / 1024).toFixed(1)} MB → ${result.dest}`);
      results.push(result);
    } catch (error) {
      console.error(`  ${store}: FAILED — ${error.message}`);
      failures += 1;
    }
  }

  try {
    const pg = await backupPostgres(args.out);
    if (pg.skipped) console.log(`  postgresql: skipped${pg.reason ? ` (${pg.reason})` : ''}`);
    else console.log(`  postgresql: ${(pg.size / 1024 / 1024).toFixed(1)} MB → ${pg.dest}`);
  } catch (error) {
    console.error(`  postgresql: FAILED — ${error.message}`);
    failures += 1;
  }

  const pruned = await pruneOld(args.out, args.keep);
  if (pruned) console.log(`Pruned ${pruned} old backup(s) (keeping ${args.keep} per store)`);

  process.exitCode = failures > 0 ? 1 : 0;
  if (failures) console.error(`${failures} backup(s) failed`);
  else console.log('Backup complete.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
