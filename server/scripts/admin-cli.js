// scripts/admin-cli.js
// The account and status commands behind the terminal admin panel (server/admin.sh). It runs inside the
// API container, with direct database access. Command-line access to the server is what authorizes
// it, so it asks for no sign-in. Book contents are never shown.
//
//   node scripts/admin-cli.js status
//   node scripts/admin-cli.js users
//   node scripts/admin-cli.js invite <member|admin>
//   node scripts/admin-cli.js reset <email>
//   node scripts/admin-cli.js disable <email>
//   node scripts/admin-cli.js enable <email>
//   node scripts/admin-cli.js role <email> <member|admin>
//   node scripts/admin-cli.js delete <email>
//
// `status` and `users` print tab-separated lines, for admin.sh to read. Errors go to stderr with exit
// code 1.

require('dotenv').config({ quiet: true });

const pool = require('../db');
const auth = require('../auth');
const accounts = require('../accounts');
const { version } = require('../appMeta');

const say = (text) => process.stdout.write(`${text}\n`);

/**
 * Finds an account by email.
 * In: the email. Out: the account's id. Throws an AccountError if there's none.
 */
async function idFor(email) {
  const { rows } = await pool.query('select id from users where email = $1', [String(email || '').trim().toLowerCase()]);
  if (!rows[0]) throw new accounts.AccountError(`No account with the email ${email}.`);
  return rows[0].id;
}

/**
 * Prints the status as name<tab>value lines.
 */
async function status() {
  const { rows: [counts] } = await pool.query(
    `select (select count(*) from users) as users, (select count(*) from users where disabled_at is not null) as disabled,
            (select count(*) from books where not deleted) as books,
            (select count(*) from sessions where expires_at > now()) as sessions`
  );
  const { rows: [meta] } = await pool.query(`select coalesce(extract(epoch from now() - agent_seen_at)::int, -1) as agent_age from app_meta where id = 1`);
  const { rows: [backup] } = await pool.query(
    `select to_char(finished_at, 'YYYY-MM-DD HH24:MI') as at, ok, uploaded, coalesce(message, '') as message from backup_runs order by id desc limit 1`
  );
  const { rows: [job] } = await pool.query(`select kind, status, coalesce(arg, '') as arg from admin_jobs order by id desc limit 1`);
  say(`version\t${version}`);
  say(`users\t${counts.users}`);
  say(`disabled\t${counts.disabled}`);
  say(`books\t${counts.books}`);
  say(`sessions\t${counts.sessions}`);
  say(`agent_age\t${meta ? meta.agent_age : -1}`);
  say(`backup_at\t${backup ? backup.at : ''}`);
  say(`backup_ok\t${backup ? backup.ok : ''}`);
  say(`backup_uploaded\t${backup ? backup.uploaded : ''}`);
  say(`backup_message\t${backup ? backup.message.replace(/\s+/g, ' ') : ''}`);
  say(`job\t${job ? `${job.kind} ${job.arg} ${job.status}`.replace(/\s+/g, ' ') : ''}`);
}

/**
 * Runs the command named on the command line.
 * In: the arguments. Side effects: as each command says.
 */
async function run([command, first, second]) {
  switch (command) {
    case 'status':
      await status();
      break;
    case 'users':
      // Prints email, name, role, active or disabled, and book count.
      for (const a of await accounts.listAccounts()) {
        say([a.email, a.displayName.replace(/\s+/g, ' '), a.role, a.disabled ? 'disabled' : 'active', a.bookCount].join('\t'));
      }
      break;
    case 'invite': {
      if (first !== 'member' && first !== 'admin') throw new accounts.AccountError('The role must be member or admin.');
      say(await auth.createInvite(first, null));
      break;
    }
    case 'reset':
      say(await auth.createResetCode(await idFor(first), null));
      break;
    case 'disable':
      await accounts.setDisabled(await idFor(first), true);
      break;
    case 'enable':
      await accounts.setDisabled(await idFor(first), false);
      break;
    case 'role':
      await accounts.setRole(await idFor(first), second);
      break;
    case 'delete':
      await accounts.deleteAccount(await idFor(first));
      break;
    case 'version':
      say(version);
      break;
    default:
      throw new accounts.AccountError('Unknown command. See the top of this file.');
  }
}

run(process.argv.slice(2))
  .then(() => pool.end())
  .catch(async (err) => {
    // An AccountError is written for people. Anything else is unexpected.
    process.stderr.write(`${err instanceof accounts.AccountError ? err.message : `Failed: ${err.message}`}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
