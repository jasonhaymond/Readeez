// accounts.js
// Managing family accounts: listing, disabling, changing roles and deleting. Used by the app's
// admin routes (routes/admin.js) and the terminal admin panel (scripts/admin-cli.js), so both
// follow the same rules. The main rule: the family can never be left without a working admin.

const pool = require('./db');
const { deleteSessions } = require('./auth');

/** A refusal worth showing to the admin, such as removing the last admin. */
class AccountError extends Error {}

/**
 * Lists every account, with a book count but never any book contents.
 * Out: an array of accounts.
 */
async function listAccounts() {
  const { rows } = await pool.query(
    `select u.id, u.email, u.display_name, u.role, u.disabled_at,
            (select count(*)::int from books b where b.user_id = u.id and not b.deleted) as book_count
       from users u order by u.display_name, u.email`
  );
  return rows.map((u) => ({
    id: u.id, email: u.email, displayName: u.display_name, role: u.role, disabled: Boolean(u.disabled_at), bookCount: u.book_count,
  }));
}

/**
 * Runs a change that could remove an admin, refusing it if it would remove the last working one.
 * In: the account's id, and a function given a database client to make the change with.
 * Side effects: whatever the change does. The admin rows stay locked until the transaction ends,
 * so two simultaneous changes can't each remove "the other" admin and leave none.
 * Throws an AccountError if the account doesn't exist or is the last working admin.
 */
async function changeGuardingLastAdmin(id, change) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: admins } = await client.query(`select id from users where role = 'admin' and disabled_at is null for update`);
    const { rows: [target] } = await client.query('select id from users where id = $1', [id]);
    if (!target) throw new AccountError('No such account.');
    if (admins.length === 1 && admins[0].id === id) {
      throw new AccountError('That\'s the only working admin. Make someone else an admin first.');
    }
    await change(client);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Disables or re-enables an account.
 * In: the id and true/false. Side effects: disabling signs that person out everywhere at once.
 * Their books are kept.
 */
async function setDisabled(id, disabled) {
  if (!disabled) {
    const { rowCount } = await pool.query('update users set disabled_at = null where id = $1', [id]);
    if (!rowCount) throw new AccountError('No such account.');
    return;
  }
  await changeGuardingLastAdmin(id, (client) => client.query('update users set disabled_at = now() where id = $1', [id]));
  await deleteSessions(id);
}

/**
 * Makes an account an admin or a regular member.
 * In: the id and 'admin' or 'member'. Side effects: changes the role, effective immediately.
 */
async function setRole(id, role) {
  if (role !== 'admin' && role !== 'member') throw new AccountError('The role must be admin or member.');
  if (role === 'admin') {
    const { rowCount } = await pool.query(`update users set role = 'admin' where id = $1`, [id]);
    if (!rowCount) throw new AccountError('No such account.');
    return;
  }
  await changeGuardingLastAdmin(id, (client) => client.query(`update users set role = 'member' where id = $1`, [id]));
}

/**
 * Permanently deletes an account and, by database cascade, its books, sessions and Nextcloud
 * connection. Backups taken earlier still hold them until they age out.
 * In: the id. Side effects: can't be undone, except by restoring a backup.
 */
async function deleteAccount(id) {
  await changeGuardingLastAdmin(id, (client) => client.query('delete from users where id = $1', [id]));
}

module.exports = { AccountError, listAccounts, setDisabled, setRole, deleteAccount };
