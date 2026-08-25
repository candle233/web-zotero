'use strict';

/**
 * PostgreSQL-backed UserStore — API-compatible with the SQLite UserStore
 * (src/users.js) but fully async. Selected in server.js when DATABASE_URL is
 * set, giving the R7b team build a shared database instead of per-instance
 * SQLite files. Password hashing and token handling are reused verbatim.
 */

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { SCRYPT, hashPassword, verifyPassword, hashToken } = require('./users');

const ROLES = ['owner', 'editor', 'viewer'];
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function toUser(row) {
  if (!row) return null;
  return { id: Number(row.id), email: row.email, displayName: row.display_name, role: row.role };
}

class PgUserStore {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async count() {
    const { rows } = await this.pool.query('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL');
    return Number(rows[0].n);
  }

  async listUsers() {
    const { rows } = await this.pool.query(`
      SELECT id, email, display_name AS "displayName", role, created_at AS "createdAt"
      FROM users WHERE deleted_at IS NULL ORDER BY id
    `);
    return rows.map(row => ({ ...row, id: Number(row.id), createdAt: row.createdAt?.toISOString?.() ?? row.createdAt }));
  }

  async userById(id) {
    const { rows } = await this.pool.query(
      'SELECT id, email, display_name, role FROM users WHERE id = $1 AND deleted_at IS NULL',
      [Number(id)]
    );
    return toUser(rows[0]);
  }

  async createUser({ email, password, role = 'editor', displayName = '' }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw httpError(400, 'A valid email address is required.');
    if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
    if ((await this.count()) === 0) role = 'owner'; // first account bootstraps the owner
    try {
      const { rows } = await this.pool.query(`
        INSERT INTO users (email, display_name, password_hash, role)
        VALUES ($1, $2, $3, $4) RETURNING id
      `, [normalizedEmail, String(displayName || '').slice(0, 200), hashPassword(password), role]);
      return await this.userById(Number(rows[0].id));
    } catch (error) {
      if (String(error.message).includes('users_email_lower_key')) throw httpError(409, 'A user with this email already exists.');
      throw error;
    }
  }

  async updateUser(id, { role, displayName, password } = {}) {
    const current = await this.userById(id);
    if (!current) throw httpError(404, 'User not found.');
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`);
      const owners = await this.pool.query("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role = 'owner'");
      if (current.role === 'owner' && role !== 'owner' && Number(owners.rows[0].n) <= 1) {
        throw httpError(409, 'Cannot demote the last owner.');
      }
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      throw httpError(400, 'Password must be at least 8 characters.');
    }
    const hash = password !== undefined
      ? hashPassword(password)
      : (await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [Number(id)])).rows[0].password_hash;
    await this.pool.query(`
      UPDATE users SET
        role = COALESCE($2, role),
        display_name = COALESCE($3, display_name),
        password_hash = $4,
        updated_at = now()
      WHERE id = $1
    `, [Number(id), role ?? null, displayName !== undefined ? String(displayName).slice(0, 200) : null, hash]);
    if (password !== undefined) await this.revokeUserSessions(Number(id));
    return this.userById(Number(id));
  }

  async deleteUser(id) {
    const user = await this.userById(id);
    if (!user) throw httpError(404, 'User not found.');
    const owners = await this.pool.query("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role = 'owner'");
    if (user.role === 'owner' && Number(owners.rows[0].n) <= 1) throw httpError(409, 'Cannot delete the last owner.');
    await this.pool.query('UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = $1', [Number(id)]);
    await this.revokeUserSessions(Number(id));
    return { ok: true };
  }

  async authenticate(email, password) {
    const { rows } = await this.pool.query(`
      SELECT id, email, display_name, password_hash, role FROM users
      WHERE lower(email) = $1 AND deleted_at IS NULL
    `, [String(email || '').trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) throw httpError(401, 'Invalid email or password.');
    return { id: Number(user.id), email: user.email, displayName: user.display_name, role: user.role };
  }

  async issueToken(user, { ttlMs = DEFAULT_TOKEN_TTL_MS } = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.pool.query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, now() + make_interval(secs => $3))
    `, [hashToken(token), user.id, ttlMs / 1000]);
    await this.purgeExpiredSessions();
    return token;
  }

  async resolveToken(token) {
    if (!token || typeof token !== 'string') return null;
    const { rows } = await this.pool.query(`
      SELECT s.token_hash, s.expires_at, u.id, u.email, u.display_name, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND u.deleted_at IS NULL
    `, [hashToken(token)]);
    const session = rows[0];
    if (!session) return null;
    if (new Date(session.expires_at) <= new Date()) {
      await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
      return null;
    }
    await this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [hashToken(token)]);
    return {
      id: Number(session.id), email: session.email, displayName: session.display_name,
      role: session.role, expiresAt: new Date(session.expires_at).toISOString()
    };
  }

  async revokeToken(token) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async revokeUserSessions(userId) {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [Number(userId)]);
  }

  async purgeExpiredSessions() {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  }

  /** Mirrors the SQLite store's contract; returns the caller's fresh token. */
  async changePassword(id, currentPassword, newPassword) {
    const { rows } = await this.pool.query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL',
      [Number(id)]
    );
    if (!rows[0]) throw httpError(404, 'User not found.');
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw httpError(400, 'New password must be at least 8 characters.');
    }
    if (!verifyPassword(currentPassword, rows[0].password_hash)) {
      throw httpError(403, 'Current password is incorrect.');
    }
    await this.pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [Number(id), hashPassword(newPassword)]);
    return { ok: true };
  }

  async listSessions(userId, currentTokenHash = null) {
    const { rows } = await this.pool.query(`
      SELECT token_hash, created_at, last_seen_at, expires_at
      FROM sessions WHERE user_id = $1 ORDER BY last_seen_at DESC
    `, [Number(userId)]);
    return rows.map(row => ({
      ref: row.token_hash.slice(0, 12),
      createdAt: new Date(row.created_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      current: currentTokenHash != null && row.token_hash === currentTokenHash
    }));
  }

  async revokeSession(userId, sessionRef) {
    const sessions = await this.listSessions(Number(userId));
    if (!sessions.some(row => row.ref === String(sessionRef))) throw httpError(404, 'Session not found.');
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND substr(token_hash, 1, 12) = $2', [Number(userId), String(sessionRef)]);
    return { ok: true };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PgUserStore, ROLES, SCRYPT, DEFAULT_TOKEN_TTL_MS };
