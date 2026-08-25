'use strict';

/**
 * PostgreSQL-backed Workspace management (R7b Phase 3).
 *
 * Implements workspace creation, membership, and RBAC on top of
 * `workspaces` and `workspace_members` tables in db/schema.sql.
 */

const { Pool } = require('pg');

const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'];

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

class PgWorkspaceStore {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString: String(connectionString || '').trim(), max: 10 });
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  async getMemberRole(workspaceId, userId) {
    const { rows } = await this.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [Number(workspaceId), Number(userId)]
    );
    return rows[0]?.role || null;
  }

  async requireAccess(workspaceId, actor, minRole = 'viewer') {
    if (!actor) throw httpError(401, 'Authentication required.');
    if (actor.role === 'owner') return 'owner'; // server-level owner has superadmin rights
    const memberRole = await this.getMemberRole(workspaceId, actor.id);
    if (!memberRole) throw httpError(404, 'Workspace not found or access denied.');
    const rank = { viewer: 0, editor: 1, owner: 2 };
    if ((rank[memberRole] ?? -1) < (rank[minRole] ?? 0)) {
      throw httpError(403, `This action requires ${minRole} role in the workspace.`);
    }
    return memberRole;
  }

  async listWorkspaces(userId) {
    const { rows } = await this.query(`
      SELECT
        w.id,
        w.name,
        w.is_personal AS "isPersonal",
        w.owner_id AS "ownerId",
        wm.role,
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt",
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS "memberCount"
      FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = $1
      ORDER BY w.is_personal DESC, w.id ASC
    `, [Number(userId)]);

    return rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      isPersonal: Boolean(row.isPersonal),
      ownerId: Number(row.ownerId),
      role: row.role,
      memberCount: Number(row.memberCount),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString()
    }));
  }

  async getWorkspace(workspaceId, actor) {
    await this.requireAccess(workspaceId, actor, 'viewer');
    const { rows } = await this.query(`
      SELECT
        w.id,
        w.name,
        w.is_personal AS "isPersonal",
        w.owner_id AS "ownerId",
        w.created_at AS "createdAt",
        w.updated_at AS "updatedAt",
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS "memberCount"
      FROM workspaces w
      WHERE w.id = $1
    `, [Number(workspaceId)]);
    const row = rows[0];
    if (!row) throw httpError(404, 'Workspace not found.');
    const role = actor.role === 'owner' ? 'owner' : (await this.getMemberRole(workspaceId, actor.id));
    return {
      id: Number(row.id),
      name: row.name,
      isPersonal: Boolean(row.isPersonal),
      ownerId: Number(row.ownerId),
      role,
      memberCount: Number(row.memberCount),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString()
    };
  }

  async createWorkspace({ name, isPersonal = false, ownerId }) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw httpError(400, 'Workspace name is required.');
    if (!ownerId) throw httpError(400, 'Owner user ID is required.');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wsRes = await client.query(`
        INSERT INTO workspaces (name, is_personal, owner_id)
        VALUES ($1, $2, $3)
        RETURNING id, name, is_personal AS "isPersonal", owner_id AS "ownerId", created_at AS "createdAt", updated_at AS "updatedAt"
      `, [trimmedName.slice(0, 200), Boolean(isPersonal), Number(ownerId)]);
      const ws = wsRes.rows[0];

      await client.query(`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `, [Number(ws.id), Number(ownerId)]);

      await client.query('COMMIT');
      return {
        id: Number(ws.id),
        name: ws.name,
        isPersonal: Boolean(ws.isPersonal),
        ownerId: Number(ws.ownerId),
        role: 'owner',
        memberCount: 1,
        createdAt: new Date(ws.createdAt).toISOString(),
        updatedAt: new Date(ws.updatedAt).toISOString()
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async updateWorkspace(workspaceId, { name }, actor) {
    await this.requireAccess(workspaceId, actor, 'owner');
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw httpError(400, 'Workspace name is required.');

    const { rows } = await this.query(`
      UPDATE workspaces SET name = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, name, is_personal AS "isPersonal", owner_id AS "ownerId", created_at AS "createdAt", updated_at AS "updatedAt"
    `, [Number(workspaceId), trimmedName.slice(0, 200)]);
    if (!rows[0]) throw httpError(404, 'Workspace not found.');
    return this.getWorkspace(workspaceId, actor);
  }

  async deleteWorkspace(workspaceId, actor) {
    await this.requireAccess(workspaceId, actor, 'owner');
    const result = await this.query('DELETE FROM workspaces WHERE id = $1', [Number(workspaceId)]);
    if (Number(result.rowCount) === 0) throw httpError(404, 'Workspace not found.');
    return { ok: true };
  }

  // ----------------------------------------------------------------- members

  async listMembers(workspaceId, actor) {
    await this.requireAccess(workspaceId, actor, 'viewer');
    const { rows } = await this.query(`
      SELECT
        u.id AS "userId",
        u.email,
        u.display_name AS "displayName",
        wm.role,
        wm.joined_at AS "joinedAt"
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1 AND u.deleted_at IS NULL
      ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, wm.joined_at ASC
    `, [Number(workspaceId)]);

    return rows.map(row => ({
      userId: Number(row.userId),
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      joinedAt: new Date(row.joinedAt).toISOString()
    }));
  }

  async addMember(workspaceId, { userId, email, role = 'editor' }, actor) {
    await this.requireAccess(workspaceId, actor, 'owner');
    if (!WORKSPACE_ROLES.includes(role)) {
      throw httpError(400, `Role must be one of: ${WORKSPACE_ROLES.join(', ')}.`);
    }

    let targetUserId = userId ? Number(userId) : null;
    if (!targetUserId && email) {
      const userRes = await this.query(
        'SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
        [String(email).trim().toLowerCase()]
      );
      if (!userRes.rows[0]) throw httpError(404, 'User with that email address does not exist.');
      targetUserId = Number(userRes.rows[0].id);
    }
    if (!targetUserId) throw httpError(400, 'User ID or valid email address is required.');

    await this.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `, [Number(workspaceId), targetUserId, role]);

    const members = await this.listMembers(workspaceId, actor);
    return members.find(m => m.userId === targetUserId);
  }

  async updateMemberRole(workspaceId, targetUserId, { role }, actor) {
    await this.requireAccess(workspaceId, actor, 'owner');
    if (!WORKSPACE_ROLES.includes(role)) {
      throw httpError(400, `Role must be one of: ${WORKSPACE_ROLES.join(', ')}.`);
    }

    const currentRole = await this.getMemberRole(workspaceId, targetUserId);
    if (!currentRole) throw httpError(404, 'Member not found in workspace.');

    if (currentRole === 'owner' && role !== 'owner') {
      const { rows } = await this.query(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
        [Number(workspaceId)]
      );
      if (Number(rows[0].n) <= 1) {
        throw httpError(409, 'Cannot demote the last owner of the workspace.');
      }
    }

    await this.query(
      'UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [Number(workspaceId), Number(targetUserId), role]
    );

    const members = await this.listMembers(workspaceId, actor);
    return members.find(m => m.userId === Number(targetUserId));
  }

  async removeMember(workspaceId, targetUserId, actor) {
    const isSelf = actor && actor.id === Number(targetUserId);
    if (!isSelf) {
      await this.requireAccess(workspaceId, actor, 'owner');
    } else {
      await this.requireAccess(workspaceId, actor, 'viewer');
    }

    const currentRole = await this.getMemberRole(workspaceId, targetUserId);
    if (!currentRole) throw httpError(404, 'Member not found in workspace.');

    if (currentRole === 'owner') {
      const { rows } = await this.query(
        "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
        [Number(workspaceId)]
      );
      if (Number(rows[0].n) <= 1) {
        throw httpError(409, 'Cannot remove the last owner of the workspace.');
      }
    }

    await this.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [Number(workspaceId), Number(targetUserId)]
    );

    return { ok: true };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PgWorkspaceStore, WORKSPACE_ROLES };
