'use strict';

const http = require('node:http');

const PORT = 8499;
process.env.PORT = String(PORT);
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'authorization': `Bearer ${token}` } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
        } catch {
          resolve({ status: res.statusCode, text: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  if (!DATABASE_URL) {
    console.log('DATABASE_URL not set; skipping live server API verification.');
    return;
  }

  console.log('Starting server in PG mode for HTTP API verification...');
  const { main: startServer } = require('../src/server');
  startServer();

  // Wait for server to listen
  await new Promise(r => setTimeout(r, 2000));

  console.log('Testing workspace HTTP routes...');
  const ts = Date.now();
  const ownerEmail = `api_owner_${ts}@example.com`;
  const memberEmail = `api_member_${ts}@example.com`;

  const { PgUserStore } = require('../src/users-pg');
  const userStore = new PgUserStore(DATABASE_URL);
  const owner = await userStore.createUser({ email: ownerEmail, password: 'password123', displayName: 'API Owner', role: 'owner' });
  const member = await userStore.createUser({ email: memberEmail, password: 'password123', displayName: 'API Member', role: 'editor' });
  const ownerToken = await userStore.issueToken(owner);
  const memberToken = await userStore.issueToken(member);

  // 1. Create workspace via POST /api/workspaces
  const createRes = await request('POST', '/api/workspaces', { name: 'Quantum Optics Team' }, ownerToken);
  console.log('POST /api/workspaces status:', createRes.status, createRes.data);
  if (createRes.status !== 201) throw new Error('Failed to create workspace');
  const wsId = createRes.data.workspace.id;

  // 2. List workspaces via GET /api/workspaces
  const listRes = await request('GET', '/api/workspaces', null, ownerToken);
  console.log('GET /api/workspaces status:', listRes.status, 'count:', listRes.data.workspaces.length);

  // 3. Add member via POST /api/workspaces/:id/members
  const addRes = await request('POST', `/api/workspaces/${wsId}/members`, { email: memberEmail, role: 'editor' }, ownerToken);
  console.log('POST /api/workspaces/:id/members status:', addRes.status, addRes.data);
  if (addRes.status !== 201) throw new Error('Failed to add member');

  // 4. Change member role via PATCH /api/workspaces/:id/members/:userId
  const patchRes = await request('PATCH', `/api/workspaces/${wsId}/members/${member.id}`, { role: 'viewer' }, ownerToken);
  console.log('PATCH /api/workspaces/:id/members/:userId status:', patchRes.status, patchRes.data);
  if (patchRes.status !== 200 || patchRes.data.member.role !== 'viewer') throw new Error('Failed to update member role');

  // 5. List members via GET /api/workspaces/:id/members
  const listMembersRes = await request('GET', `/api/workspaces/${wsId}/members`, null, memberToken);
  console.log('GET /api/workspaces/:id/members status:', listMembersRes.status, 'count:', listMembersRes.data.members.length);

  // 6. Remove member via DELETE /api/workspaces/:id/members/:userId
  const delMemberRes = await request('DELETE', `/api/workspaces/${wsId}/members/${member.id}`, null, ownerToken);
  console.log('DELETE /api/workspaces/:id/members/:userId status:', delMemberRes.status, delMemberRes.data);
  if (delMemberRes.status !== 200) throw new Error('Failed to delete member');

  // 7. Delete workspace via DELETE /api/workspaces/:id
  const delWsRes = await request('DELETE', `/api/workspaces/${wsId}`, null, ownerToken);
  console.log('DELETE /api/workspaces/:id status:', delWsRes.status, delWsRes.data);
  if (delWsRes.status !== 200) throw new Error('Failed to delete workspace');

  // Clean up users
  await userStore.deleteUser(owner.id);
  await userStore.deleteUser(member.id);
  await userStore.close();

  console.log('Workspace API integration test PASSED completely!');
  process.exit(0);
}

main().catch(err => {
  console.error('Workspace API integration test FAILED:', err);
  process.exit(1);
});
