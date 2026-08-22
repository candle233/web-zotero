'use strict';

/**
 * Bootstraps / manages accounts for the multi-user mode (R7).
 *
 * Usage:
 *   node scripts/add-user.js <email> <password> [--role owner|editor|viewer] [--display "Name"]
 *
 * The first account created in an empty database always becomes the owner.
 */

const path = require('node:path');
const { UserStore } = require('../src/users');

function parseArgs(argv) {
  const [email, password, ...rest] = argv;
  const options = { role: undefined, display: '' };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--role') options.role = rest[i + 1];
    else if (rest[i] === '--display') options.display = rest[i + 1] || '';
  }
  return { email, password, options };
}

async function main() {
  const { email, password, options } = parseArgs(process.argv.slice(2));
  if (!email || !password) {
    console.error('Usage: node scripts/add-user.js <email> <password> [--role owner|editor|viewer] [--display "Name"]');
    process.exitCode = 1;
    return;
  }
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const store = new UserStore(dataDir);
  try {
    const user = store.createUser({ email, password, role: options.role, displayName: options.display });
    console.log(`Created user ${user.email} (role: ${user.role}, id: ${user.id})`);
    console.log(`Auth mode is now "users" with ${store.count()} account(s).`);
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error(error.statusCode ? error.message : error);
  process.exitCode = 1;
});
