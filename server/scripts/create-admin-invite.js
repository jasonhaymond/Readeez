// scripts/create-admin-invite.js
// Prints an invite code that creates an admin account. This is how the first account
// comes to exist, since the app has no public sign-up. Also the way back in if every
// admin is locked out. Needs command-line access to the server, which is the proof of
// authority here:
//
//   docker compose exec api node scripts/create-admin-invite.js

require('dotenv').config({ quiet: true });

const pool = require('../db');
const { createInvite } = require('../auth');

/**
 * Makes the code and prints it.
 * Side effects: adds an access_codes row. The plain code appears only in this output.
 */
async function main() {
  const code = await createInvite('admin', null);
  process.stdout.write(`\nAdmin invite code: ${code}\n`);
  process.stdout.write('It works once, expires in 7 days, and can\'t be shown again.\n');
  process.stdout.write('In the Readeez app, choose "I have an invite code" and enter it.\n\n');
  await pool.end();
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
