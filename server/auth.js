// auth.js
// Passwords, sessions and one-time codes, plus the "middleware" that guards routes
// (middleware: a function Express runs before a route's own handler, which can
// refuse the request). Used by every route file. This is the core of the app's
// access control, so changes here need the deepest security review.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('./db');

// bcrypt work factor: higher is slower to crack, and slower to sign in. Lowered
// only in the test suite, where hundreds of hashes would otherwise take minutes.
const BCRYPT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const RESET_HISTORY_SHOWN = 20;
const MIN_PASSWORD = 10;
// bcrypt ignores everything past 72 bytes. Refusing longer passwords means two
// different long passwords can't both open the same account.
const MAX_PASSWORD_BYTES = 72;

// Compared against when an email isn't found, so that request takes as long as a
// real wrong password. Otherwise response time reveals which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

/**
 * Checks a new password against the rules.
 * In: the candidate. Out: a message to show, or null if it's acceptable.
 */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'That password is too long (72 characters at most).';
  return null;
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

/**
 * Checks a sign-in password.
 * In: the typed password and the stored hash (or null when there's no such
 * account). Out: true only for a real match. Always does the slow comparison, so
 * the two failure cases can't be told apart by timing.
 */
async function checkPassword(password, hash) {
  const matches = await bcrypt.compare(String(password), hash || DUMMY_HASH);
  return Boolean(hash) && matches;
}

// Hashes tokens and codes for storage. Plain SHA-256 is right here, unlike for
// passwords, because these values are long and random and can't be guessed.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Starts a session for a device.
 * In: the user's id and, for a sign-in, the password hash that was just checked.
 * Out: the token to give the device (shown nowhere else), or null if that hash is no longer current or the
 * account is disabled.
 * Side effects: inserts a sessions row holding only the token's hash.
 *
 * Checking a password is deliberately slow, so the password can change while a sign-in is checking the
 * old one. Without the hash condition, that sign-in would get a session just after the change had ended
 * them all, and someone who knew the old password would keep their access. "for share" makes this wait
 * for any password change in progress, then look at the new hash. A session made just before a change
 * is removed by that change.
 */
async function createSession(userId, passwordHash = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rowCount } = await pool.query(
    `insert into sessions (token_hash, user_id, expires_at)
     select $1, id, now() + make_interval(days => $3) from users
      where id = $2 and disabled_at is null and ($4::text is null or password_hash = $4) for share`,
    [sha256(token), userId, SESSION_DAYS, passwordHash]
  );
  return rowCount ? token : null;
}

/**
 * Sets a new password and ends what the old one could have started: other sessions, the Nextcloud link (and
 * its stored app password), and unused codes the person created or that were made for them. All of it happens
 * together, because a password change is what someone does after a suspected break-in, and a partial one leaves
 * a way back in. Used codes stay, since they're the reset history.
 * In: a database client inside a transaction, the user's id, the new hash, and optionally keepToken (the session
 * to keep: the device making the change) and expectedHash (the hash the caller's password check was against).
 * Out: { changed, nextcloudDisconnected }. changed is false, with nothing altered, if the password has moved on.
 *
 * expectedHash matters because that check is deliberately slow. Without it, a password change already underway
 * could finish after a newer reset, and overwrite it with a password the attacker chose. The database re-reads
 * the condition after waiting on any change in progress, so this holds whichever one reaches the row first.
 */
async function applyNewPassword(client, userId, hash, { keepToken = null, expectedHash = null } = {}) {
  const { rowCount: updated } = await client.query(
    'update users set password_hash = $1 where id = $2 and ($3::text is null or password_hash = $3)',
    [hash, userId, expectedHash]
  );
  if (!updated) return { changed: false, nextcloudDisconnected: false };
  await client.query('delete from sessions where user_id = $1 and token_hash <> $2', [userId, keepToken ? sha256(keepToken) : '']);
  const { rowCount } = await client.query('delete from nextcloud_links where user_id = $1', [userId]);
  await client.query(
    `delete from access_codes where used_at is null and (created_by = $1 or (kind = 'reset' and user_id = $1))`,
    [userId]
  );
  return { changed: true, nextcloudDisconnected: rowCount > 0 };
}

/**
 * Confirms a session is still valid, for a request that waited on something slow after signing in. Without this,
 * a request held open across a password change could finish afterward and undo part of what that change ended.
 * In: a database client inside a transaction, the user's id, and the token. Out: true or false.
 * Two separate steps on purpose. The first waits for any password change in progress, and the second is a new
 * query, so it sees that change's result. One combined query would still see the session as it was when it started.
 */
async function sessionStillValid(client, userId, token) {
  await client.query('select 1 from users where id = $1 for share', [userId]);
  const { rows } = await client.query(
    'select 1 from sessions where token_hash = $1 and user_id = $2 and expires_at > now()',
    [sha256(token), userId]
  );
  return rows.length > 0;
}

/**
 * Ends one session (signing out one device).
 * In: the plain token. Side effects: deletes its row, so the token stops working.
 */
async function deleteSession(token) {
  await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

/**
 * Ends all of a person's sessions, optionally keeping the current device's. Used when an
 * account is disabled, so a stolen token dies too. A password change does this itself, in
 * its own transaction (see applyNewPassword).
 * In: the user's id, and optionally the token to keep. Side effects: deletes rows.
 */
async function deleteSessions(userId, exceptToken = null) {
  await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [
    userId,
    exceptToken ? sha256(exceptToken) : '',
  ]);
}

/**
 * Middleware: lets a request through only with a valid session. Protects every
 * route that isn't deliberately public. Answers 401 otherwise.
 * In: the "Authorization: Bearer <token>" header. Out: sets req.user and req.token.
 * Side effects: extends a session's expiry, at most once a day, so a phone in
 * regular use stays signed in while an abandoned one expires.
 */
async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please sign in.' });

  // Finds the session only if it's unexpired and its account isn't disabled.
  const { rows } = await pool.query(
    `select u.id, u.email, u.display_name, u.role, s.last_used_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.disabled_at is null`,
    [sha256(token)]
  );
  if (!rows[0]) return res.status(401).json({ error: 'Please sign in.' });

  if (Date.now() - rows[0].last_used_at.getTime() > 24 * 3600 * 1000) {
    await pool.query(
      `update sessions set last_used_at = now(), expires_at = now() + make_interval(days => $2) where token_hash = $1`,
      [sha256(token), SESSION_DAYS]
    );
  }
  req.user = rows[0];
  req.token = token;
  return next();
}

/**
 * Middleware, placed after requireAuth: refuses anyone who isn't an admin with a
 * 403. Protects account management and server status from regular family members.
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can do that.' });
  return next();
}

/**
 * Makes a new one-time code, like 'K7QM-2XPA-9RTB-4HNC' (80 random bits).
 * Out: the code. The alphabet leaves out I, L, O and U, which are easily misread
 * when someone reads a code aloud to a family member.
 */
function generateCode() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let group = '';
    // randomInt draws evenly, so no character is more likely than another.
    for (let i = 0; i < 4; i += 1) group += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join('-');
}

// Lets a code be typed in lower case or without the dashes.
const hashCode = (code) => sha256(String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, ''));

/**
 * Creates an invite code for a new family member.
 * In: role ('admin' or 'member'), the creating admin's id (null for a code from the command line),
 * and optionally a database client to join a transaction. Out: the plain code, shown only this once.
 * Side effects: inserts a hashed access_codes row that expires in 7 days.
 */
async function createInvite(role, createdBy, db = pool) {
  const code = generateCode();
  await db.query(
    `insert into access_codes (code_hash, kind, role, created_by, expires_at)
     values ($1, 'invite', $2, $3, now() + make_interval(days => $4))`,
    [hashCode(code), role, createdBy, INVITE_DAYS]
  );
  return code;
}

/**
 * Creates a password-reset code. There's no email in this app, so an admin hands
 * the code to the person directly.
 * In: the account's id, the admin's id (null for a code from the command line), and optionally a
 * database client to join a transaction. Out: the plain code, shown only once.
 * Side effects: cancels any earlier unused reset codes for that account, and
 * inserts a new one that expires in 24 hours.
 *
 * It locks the account first, for two reasons. A password change in progress finishes first, so that change can't
 * miss this code and leave it working afterward. And a reset in progress finishes first, because that reset holds
 * the account and wants a code this would otherwise be holding, which is a deadlock. Inside a transaction the lock
 * lasts until commit. On the terminal panel's plain connection it only waits for whatever is in progress.
 */
async function createResetCode(userId, createdBy, db = pool) {
  const code = generateCode();
  await db.query('select 1 from users where id = $1 for share', [userId]);
  await db.query(`delete from access_codes where kind = 'reset' and user_id = $1 and used_at is null`, [userId]);
  await db.query(
    `insert into access_codes (code_hash, kind, user_id, created_by, expires_at)
     values ($1, 'reset', $2, $3, now() + make_interval(hours => $4))`,
    [hashCode(code), userId, createdBy, RESET_HOURS]
  );
  return code;
}

/**
 * Locks the account a reset code belongs to, before that code is redeemed. A password change locks the account and
 * then its codes, so a reset has to take them in the same order. In the opposite order, the two can each wait on
 * the other until Postgres cancels one, and someone resetting their password would see an error.
 * In: a database client inside a transaction, and the typed code. Side effects: holds the account's row until the
 * transaction ends. An unknown code locks nothing, and redeemCode then refuses it.
 * "for no key update" is the same strength the password update itself uses. It's enough to queue with password
 * changes, and unlike plain "for update" it doesn't block other tables' rows from referring to this account.
 */
async function lockResetAccount(client, code) {
  const { rows } = await client.query(`select user_id from access_codes where code_hash = $1 and kind = 'reset'`, [hashCode(code)]);
  if (rows[0]) await client.query('select 1 from users where id = $1 for no key update', [rows[0].user_id]);
}

/**
 * Uses up a one-time code.
 * In: a database client (so it joins the caller's transaction), the typed code and
 * the kind expected. Out: the code's row, or null if it's wrong, expired or used.
 * Side effects: marks it used. One atomic update does both the check and the
 * marking, so two simultaneous requests can't both redeem the same code.
 */
async function redeemCode(client, code, kind) {
  const { rows } = await client.query(
    `update access_codes set used_at = now()
      where code_hash = $1 and kind = $2 and used_at is null and expires_at > now()
      returning role, user_id`,
    [hashCode(code), kind]
  );
  return rows[0] || null;
}

/**
 * Lists when reset codes were used on an account, newest first. Reset codes come from an admin, who could
 * redeem one to sign in as this person, so the person is shown this history. It's read from the used codes
 * themselves, which nothing in the app deletes (only unused codes are ever cancelled), so a later reset can't
 * hide an earlier one, and someone signed in as the person can't clear it.
 * In: the account's id. Out: { recent, earlier }: the newest 20 ISO times, and how many older ones there
 * are. The count keeps the list honest: burying a visit under more resets leaves it visibly longer.
 */
async function resetHistory(userId) {
  const { rows } = await pool.query(
    `select used_at from access_codes where kind = 'reset' and user_id = $1 and used_at is not null order by used_at desc`,
    [userId]
  );
  return {
    recent: rows.slice(0, RESET_HISTORY_SHOWN).map((row) => row.used_at.toISOString()),
    earlier: Math.max(rows.length - RESET_HISTORY_SHOWN, 0),
  };
}

/**
 * Confirms a request is still coming from a working admin, just before it creates a code. A code created by a
 * request already underway when the admin's password changed, or when they were removed, would otherwise slip
 * past the cancelling and become a way back in. Waiting on the account's row (see sessionStillValid) means
 * either this sees the change and refuses, or the change comes after and cancels what this creates.
 * In: a database client inside a transaction, the user's id, and the token. Out: true or false.
 */
async function adminStillValid(client, userId, token) {
  if (!(await sessionStillValid(client, userId, token))) return false;
  const { rows } = await client.query(`select 1 from users where id = $1 and role = 'admin' and disabled_at is null`, [userId]);
  return rows.length > 0;
}

module.exports = {
  lockResetAccount,
  applyNewPassword,
  sessionStillValid,
  adminStillValid,
  resetHistory,
  passwordProblem,
  hashPassword,
  checkPassword,
  createSession,
  deleteSession,
  deleteSessions,
  requireAuth,
  requireAdmin,
  createInvite,
  createResetCode,
  redeemCode,
};
