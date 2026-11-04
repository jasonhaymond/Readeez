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
 * In: the user's id. Out: the token to give the device (shown nowhere else).
 * Side effects: inserts a sessions row holding only the token's hash.
 */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]
  );
  return token;
}

/**
 * Ends one session (signing out one device).
 * In: the plain token. Side effects: deletes its row, so the token stops working.
 */
async function deleteSession(token) {
  await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

/**
 * Ends all of a person's sessions, optionally keeping the current device's. Used
 * when a password changes or an account is disabled, so a stolen token dies too.
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
 * In: role ('admin' or 'member') and the creating admin's id (null for the first
 * admin's code from the command line). Out: the plain code, shown only this once.
 * Side effects: inserts a hashed access_codes row that expires in 7 days.
 */
async function createInvite(role, createdBy) {
  const code = generateCode();
  await pool.query(
    `insert into access_codes (code_hash, kind, role, created_by, expires_at)
     values ($1, 'invite', $2, $3, now() + make_interval(days => $4))`,
    [hashCode(code), role, createdBy, INVITE_DAYS]
  );
  return code;
}

/**
 * Creates a password-reset code. There's no email in this app, so an admin hands
 * the code to the person directly.
 * In: the account's id and the admin's id. Out: the plain code, shown only once.
 * Side effects: cancels any earlier unused reset codes for that account, and
 * inserts a new one that expires in 24 hours.
 */
async function createResetCode(userId, createdBy) {
  const code = generateCode();
  await pool.query(`delete from access_codes where kind = 'reset' and user_id = $1 and used_at is null`, [userId]);
  await pool.query(
    `insert into access_codes (code_hash, kind, user_id, created_by, expires_at)
     values ($1, 'reset', $2, $3, now() + make_interval(hours => $4))`,
    [hashCode(code), userId, createdBy, RESET_HOURS]
  );
  return code;
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

module.exports = {
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
