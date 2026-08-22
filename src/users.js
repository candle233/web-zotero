'use strict';

/**
 * Multi-user accounts for the SQLite (zero-dependency) build.
 *
 * Mirrors the users/sessions concepts of db/schema.sql (PostgreSQL team
 * build): email + password accounts, named roles, expiring bearer tokens.
 * Differences from the PG blueprint, on purpose:
 *   - argon2id is replaced by Node's built-in scrypt (no native deps),
 *   - tokens are stored as SHA-256 hashes so a leaked database does not
 *     leak usable credentials.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROLES = ['owner', 'editor', 'viewer'];
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p)
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

class UserStore {
  constructor(dataDir) {
    this.database = new DatabaseSync(path.join(dataDir, 'web-data.sqlite'));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'editor'
                      CHECK (role IN ('owner','editor','viewer')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
    `);
  }

  count() {
    return this.database.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').get().n;
  }

  listUsers() {
    return this.database.prepare(`
      SELECT id, email, display_name AS displayName, role, created_at AS createdAt
      FROM users WHERE deleted_at IS NULL ORDER BY id
    `).all();
  }

  userById(id) {
    return this.database.prepare(`
      SELECT id, email, display_name AS displayName, role FROM users
      WHERE id = ? AND deleted_at IS NULL
    `).get(Number(id));
  }

  createUser({ email, password, role = 'editor', displayName = '' }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw httpError(400, 'A valid email address is required.');
    if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
    if (this.count() === 0 && role !== 'owner') {
      // First account bootstraps the workspace owner.
      role = 'owner';
    }
    const now = new Date().toISOString();
    try {
      const result = this.database.prepare(`
        INSERT INTO users (email, display_name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedEmail, String(displayName || '').slice(0, 200), hashPassword(password), role, now, now);
      return this.userById(Number(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes('users_email_key')) throw httpError(409, 'A user with this email already exists.');
      throw error;
    }
  }

  updateUser(id, { role, displayName, password } = {}) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found.');
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
      if (user.role === 'owner' && role !== 'owner' && this.countOwners() <= 1) {
        throw httpError(409, 'Cannot demote the last owner.');
      }
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      throw httpError(400, 'Password must be at least 8 characters.');
    }
    this.database.prepare(`
      UPDATE users SET
        role = ?, display_name = ?, password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      role !== undefined ? role : user.role,
      displayName !== undefined ? String(displayName).slice(0, 200) : user.displayName,
      password !== undefined ? hashPassword(password) : this.currentPasswordHash(user.id),
      new Date().toISOString(),
      user.id
    );
    return this.userById(user.id);
  }

  currentPasswordHash(id) {
    return this.database.prepare('SELECT password_hash FROM users WHERE id = ?').get(Number(id)).password_hash;
  }

  countOwners() {
    return this.database.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role = 'owner'"
    ).get().n;
  }

  deleteUser(id) {
    const user = this.userById(id);
    if (!user) throw httpError(404, 'User not found.');
    if (user.role === 'owner' && this.countOwners() <= 1) throw httpError(409, 'Cannot delete the last owner.');
    const now = new Date().toISOString();
    this.database.prepare('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);
    this.revokeUserSessions(user.id);
    return { ok: true };
  }

  authenticate(email, password) {
    const user = this.database.prepare(`
      SELECT id, email, display_name, password_hash, role FROM users
      WHERE lower(email) = ? AND deleted_at IS NULL
    `).get(String(email || '').trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash)) throw httpError(401, 'Invalid email or password.');
    return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
  }

  issueToken(user, { ttlMs = DEFAULT_TOKEN_TTL_MS } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(hashToken(token), user.id, new Date(now).toISOString(), new Date(now).toISOString(),
      new Date(now + ttlMs).toISOString());
    this.purgeExpiredSessions();
    return token;
  }

  resolveToken(token) {
    if (!token || typeof token !== 'string') return null;
    const session = this.database.prepare(`
      SELECT s.token_hash, s.expires_at, u.id, u.email, u.display_name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.deleted_at IS NULL
    `).get(hashToken(token));
    if (!session) return null;
    if (Date.parse(session.expires_at) <= Date.now()) {
      this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
      return null;
    }
    this.database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), session.token_hash);
    return {
      id: session.id, email: session.email, displayName: session.display_name,
      role: session.role, expiresAt: session.expires_at
    };
  }

  revokeToken(token) {
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  revokeUserSessions(userId) {
    this.database.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
  }

  purgeExpiredSessions() {
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  }

  close() {
    this.database.close();
  }
}

module.exports = { UserStore, ROLES, hashPassword, verifyPassword };
