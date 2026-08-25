'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PgWorkspaceStore } = require('../src/workspaces-pg');
const { PgUserStore } = require('../src/users-pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

test('PgWorkspaceStore lifecycle and RBAC when DATABASE_URL is set', { skip: !DATABASE_URL }, async () => {
  const wsStore = new PgWorkspaceStore(DATABASE_URL);
  const userStore = new PgUserStore(DATABASE_URL);

  const timestamp = Date.now();
  const ownerEmail = `ws_owner_${timestamp}@example.com`;
  const member1Email = `ws_member1_${timestamp}@example.com`;
  const member2Email = `ws_member2_${timestamp}@example.com`;

  let ownerUser, member1User, member2User;
  let workspace;

  try {
    // Bootstrap users
    ownerUser = await userStore.createUser({ email: ownerEmail, password: 'password123', displayName: 'Workspace Owner', role: 'editor' });
    member1User = await userStore.createUser({ email: member1Email, password: 'password123', displayName: 'Member One', role: 'editor' });
    member2User = await userStore.createUser({ email: member2Email, password: 'password123', displayName: 'Member Two', role: 'viewer' });

    // 1. Create workspace
    workspace = await wsStore.createWorkspace({
      name: 'Vision & NLP Lab',
      isPersonal: false,
      ownerId: ownerUser.id
    });
    assert.ok(workspace.id > 0);
    assert.equal(workspace.name, 'Vision & NLP Lab');
    assert.equal(workspace.role, 'owner');
    assert.equal(workspace.memberCount, 1);

    // 2. List workspaces for owner
    const ownerWorkspaces = await wsStore.listWorkspaces(ownerUser.id);
    assert.ok(ownerWorkspaces.some(w => w.id === workspace.id));

    // Member 1 has no access yet
    const m1WorkspacesBefore = await wsStore.listWorkspaces(member1User.id);
    assert.equal(m1WorkspacesBefore.some(w => w.id === workspace.id), false);

    // 3. Add Member 1 by email as editor
    const addedM1 = await wsStore.addMember(workspace.id, { email: member1Email, role: 'editor' }, ownerUser);
    assert.equal(addedM1.userId, member1User.id);
    assert.equal(addedM1.role, 'editor');

    // 4. Add Member 2 by user ID as viewer
    const addedM2 = await wsStore.addMember(workspace.id, { userId: member2User.id, role: 'viewer' }, ownerUser);
    assert.equal(addedM2.userId, member2User.id);
    assert.equal(addedM2.role, 'viewer');

    // 5. List members
    const members = await wsStore.listMembers(workspace.id, member1User);
    assert.equal(members.length, 3);
    assert.equal(members[0].role, 'owner'); // sorted owners first

    // 6. Update member role: promote Member 1 to owner
    const promotedM1 = await wsStore.updateMemberRole(workspace.id, member1User.id, { role: 'owner' }, ownerUser);
    assert.equal(promotedM1.role, 'owner');

    // 7. Demoting one of two owners succeeds
    const demotedM1 = await wsStore.updateMemberRole(workspace.id, member1User.id, { role: 'editor' }, ownerUser);
    assert.equal(demotedM1.role, 'editor');

    // Demoting the last owner fails with 409
    await assert.rejects(
      async () => wsStore.updateMemberRole(workspace.id, ownerUser.id, { role: 'editor' }, ownerUser),
      err => err.statusCode === 409
    );

    // 8. Non-owner cannot add members or change roles
    await assert.rejects(
      async () => wsStore.addMember(workspace.id, { email: 'stranger@example.com' }, member2User),
      err => err.statusCode === 403
    );

    // 9. Remove Member 2
    const removeRes = await wsStore.removeMember(workspace.id, member2User.id, ownerUser);
    assert.equal(removeRes.ok, true);
    const membersAfterRemove = await wsStore.listMembers(workspace.id, ownerUser);
    assert.equal(membersAfterRemove.length, 2);

    // 10. Update workspace name
    const updatedWs = await wsStore.updateWorkspace(workspace.id, { name: 'Vision, NLP & Robotics Lab' }, ownerUser);
    assert.equal(updatedWs.name, 'Vision, NLP & Robotics Lab');

    // 11. Delete workspace
    const deleteWs = await wsStore.deleteWorkspace(workspace.id, ownerUser);
    assert.equal(deleteWs.ok, true);

    const ownerWorkspacesAfter = await wsStore.listWorkspaces(ownerUser.id);
    assert.equal(ownerWorkspacesAfter.some(w => w.id === workspace.id), false);

  } finally {
    if (workspace?.id) {
      await wsStore.query('DELETE FROM workspaces WHERE id = $1', [workspace.id]).catch(() => {});
    }
    if (ownerUser?.id) await userStore.deleteUser(ownerUser.id).catch(() => {});
    if (member1User?.id) await userStore.deleteUser(member1User.id).catch(() => {});
    if (member2User?.id) await userStore.deleteUser(member2User.id).catch(() => {});

    await wsStore.close();
    await userStore.close();
  }
});
