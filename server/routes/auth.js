// routes/auth.js
// Account routes under /api/auth: redeem an invite, sign in, redeem a reset code,
// sign out, change password. Called by the mobile app. The first three are public
// and rate-limited against guessing. Reads and writes users, sessions, access_codes.

const express = require('express');
const rateLimit = require('express-rate-limit').default;
const pool = require('../db');
const auth = require('../auth');
const log = require('../logger')('auth');

// One message for every sign-in failure, so nobody can use the sign-in form to
// learn whether an email has an account here.
const BAD_LOGIN = 'That email and password don\'t match.';
const BAD_CODE = 'That code isn\'t valid. It may have expired or already been used.';
// A simple address shape, e.g. sam@example.com: something, one @, something, with
// no spaces. Only a typo check, since no mail is ever sent to it.
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_NAME = 80;
// Control characters: invisible codes such as the terminal escape character. Admins see names and
// emails in the terminal admin panel, where these could rewrite what's on their screen.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Builds the router. A fresh one per app instance means rate-limit counters aren't
 * shared between test files.
 * Out: an Express router with the routes below.
 */
function createAuthRouter() {
  const router = express.Router();

  // Limits guessing per network address: 10 failures per 15 minutes on the public
  // routes. Successful requests don't count, so normal use never trips it.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  });

  /**
   * POST /api/auth/redeem — public. Creates an account from an invite code.
   * In: { code, email, displayName, password }. Out: { token, user }.
   * Side effects: uses up the code, inserts the user, starts a session.
   */
  router.post('/redeem', limiter, async (req, res) => {
    const { code, email, displayName, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(displayName || '').replace(CONTROL_CHARS, '').trim();
    // An email with a control character in it is refused rather than silently changed.
    if (cleanEmail.length > MAX_EMAIL || !EMAIL.test(cleanEmail) || cleanEmail.search(CONTROL_CHARS) !== -1) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!cleanName || cleanName.length > MAX_NAME) return res.status(400).json({ error: 'Enter your name.' });
    const problem = auth.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const hash = await auth.hashPassword(password);

    const client = await pool.connect();
    let user;
    try {
      // A transaction (all steps succeed or none take effect): if the email is
      // already taken, the invite is not used up.
      await client.query('begin');
      const invite = await auth.redeemCode(client, code, 'invite');
      if (!invite) {
        await client.query('rollback');
        return res.status(400).json({ error: BAD_CODE });
      }
      const { rows } = await client.query(
        `insert into users (email, display_name, password_hash, role) values ($1, $2, $3, $4)
         on conflict (email) do nothing
         returning id, email, display_name, role`,
        [cleanEmail, cleanName, hash, invite.role]
      );
      if (!rows[0]) {
        await client.query('rollback');
        // Reachable only with a valid invite, so this can't be used to probe emails.
        return res.status(409).json({ error: 'That email already has an account.' });
      }
      user = rows[0];
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    log.info(`account created: user ${user.id} role ${user.role}`);
    return res.status(201).json({ token: await auth.createSession(user.id), user: publicUser(user) });
  });

  /**
   * POST /api/auth/login — public. Signs in.
   * In: { email, password }. Out: { token, user }, or 401 with the same message
   * whether the email is unknown, the password wrong, or the account disabled.
   * Side effects: starts a session.
   */
  router.post('/login', limiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const { rows } = await pool.query(
      `select id, email, display_name, role, password_hash from users where email = $1 and disabled_at is null`,
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!(await auth.checkPassword(password, user && user.password_hash))) {
      return res.status(401).json({ error: BAD_LOGIN });
    }
    return res.json({ token: await auth.createSession(user.id), user: publicUser(user, await auth.resetHistory(user.id)) });
  });

  /**
   * POST /api/auth/reset — public. Sets a new password using an admin's reset code.
   * In: { code, password }. Out: { ok: true }.
   * Side effects: uses up the code, which stays on record as used, so the person is shown the time at their
   * next sign-in. Also changes the password, signs out every device, and disconnects Nextcloud (see below).
   */
  router.post('/reset', limiter, async (req, res) => {
    const { code, password } = req.body || {};
    const problem = auth.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const hash = await auth.hashPassword(password);

    const client = await pool.connect();
    let userId;
    try {
      await client.query('begin');
      const reset = await auth.redeemCode(client, code, 'reset');
      if (!reset) {
        await client.query('rollback');
        return res.status(400).json({ error: BAD_CODE });
      }
      userId = reset.user_id;
      await client.query('update users set password_hash = $1 where id = $2', [hash, userId]);
      // Whoever had access before this may have pointed the daily export at their own Nextcloud, which
      // would keep sending this person's books after they lost access. Signing them out alone wouldn't
      // stop that, so a new password also removes the link and its stored app password.
      await client.query('delete from nextcloud_links where user_id = $1', [userId]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await auth.deleteSessions(userId);
    log.info(`password reset by code: user ${userId}`);
    return res.json({ ok: true });
  });

  /**
   * GET /api/auth/me — signed-in users. Out: { user }, the caller's own details.
   */
  router.get('/me', auth.requireAuth, async (req, res) => {
    res.json({ user: publicUser(req.user, await auth.resetHistory(req.user.id)) });
  });

  /**
   * POST /api/auth/logout — signed-in users. Ends this device's session on the
   * server, so the token is useless even if it was copied. Out: { ok: true }.
   */
  router.post('/logout', auth.requireAuth, async (req, res) => {
    await auth.deleteSession(req.token);
    res.json({ ok: true });
  });

  /**
   * POST /api/auth/password — signed-in users; changes their own password.
   * In: { currentPassword, newPassword }. Rate-limited and re-checks the current
   * password, so someone holding an unlocked phone can't take over the account.
   * Side effects: updates the hash, signs out every other device, and disconnects Nextcloud, for the same
   * reason as a reset: changing a password is what someone does after a suspected break-in, and it has to
   * end that person's access completely. Out: { ok: true, nextcloudDisconnected }.
   */
  router.post('/password', limiter, auth.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const { rows } = await pool.query('select password_hash from users where id = $1', [req.user.id]);
    if (typeof currentPassword !== 'string' || !(await auth.checkPassword(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Your current password isn\'t right.' });
    }
    const problem = auth.passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    await pool.query('update users set password_hash = $1 where id = $2', [await auth.hashPassword(newPassword), req.user.id]);
    await auth.deleteSessions(req.user.id, req.token);
    const { rowCount } = await pool.query('delete from nextcloud_links where user_id = $1', [req.user.id]);
    return res.json({ ok: true, nextcloudDisconnected: rowCount > 0 });
  });

  return router;
}

/**
 * Picks the fields a client may see. Listing them explicitly keeps the password
 * hash out of every response, even if a query selects it.
 * In: a user row, and when reset codes were used on this account (see auth.resetHistory).
 * Out: { id, email, displayName, role, adminResets, adminResetsEarlier }.
 */
function publicUser(user, history = { recent: [], earlier: 0 }) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    adminResets: history.recent,
    adminResetsEarlier: history.earlier,
  };
}

module.exports = { createAuthRouter, publicUser };
