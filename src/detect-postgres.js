'use strict';

/**
 * PostgreSQL auto-detection for zero-config startup.
 *
 * The single most convenient configuration is to point the server at a
 * Zotero storage folder and let everything else work. PostgreSQL — when
 * installed and reachable — is detected automatically so users don't have
 * to hand-craft a DATABASE_URL; a manual DATABASE_URL still wins when set.
 */

const { Client } = require('pg');

/** Mask a connection string's password before logging it. */
function maskConnectionString(url) {
  return String(url || '').replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/i, '$1****$2');
}

/**
 * Probe whether a PostgreSQL instance is reachable.
 * @param {string} connectionString
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<boolean>}
 */
async function isPostgresReachable(connectionString, timeoutMs = 1500) {
  if (!connectionString) return false;
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    try { await client.end(); } catch {}
  }
}

/**
 * Pick the DATABASE_URL to use, auto-detecting PostgreSQL when none is set.
 * Returns the URL (or null) plus a flag indicating whether it was explicit.
 * @param {string} [envUrl]
 * @returns {Promise<{url: string|null, explicit: boolean}>}
 */
async function pickDatabaseUrl(envUrl) {
  if (envUrl) return { url: envUrl, explicit: true };

  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.PGPORT || 5432);
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD || 'password';
  const database = process.env.PGDATABASE || 'web_zotero';

  const candidates = [
    `postgresql://${user}:${password}@${host}:${port}/${database}`,
    `postgresql://${user}@${host}:${port}/${database}`,
    `postgresql://${user}@${host}:${port}/${database}?password=${password}`,
  ];

  for (const candidate of candidates) {
    if (await isPostgresReachable(candidate, 1500)) {
      return { url: candidate, explicit: false };
    }
  }

  return { url: null, explicit: false };
}

module.exports = { maskConnectionString, isPostgresReachable, pickDatabaseUrl };