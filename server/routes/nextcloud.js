// routes/nextcloud.js
// Routes under /api/nextcloud, where a signed-in person connects their own Nextcloud
// and exports to it. Each route only ever touches the caller's own link. The app
// password can be written but never read back. Reads and writes nextcloud_links.

const express = require('express');
const rateLimit = require('express-rate-limit').default;
const pool = require('../db');
const { requireAuth, sessionStillValid } = require('../auth');
const { encrypt } = require('../secrets');
const nextcloud = require('../nextcloud');
const { PostgresRateStore } = require('../rateLimitStore');

/**
 * Converts a link row into what the app may see. The encrypted password is left
 * out, so it can't appear in any response.
 * In: a row, or undefined. Out: the connection's details, or { connected: false }.
 */
function publicLink(row) {
  if (!row) return { connected: false };
  return {
    connected: true,
    baseUrl: row.base_url,
    username: row.username,
    dailyExport: row.daily_export,
    lastExportAt: row.last_export_at ? row.last_export_at.toISOString() : null,
    lastError: row.last_error,
  };
}

/**
 * Sends a NextcloudError back as a 400 with its message. Anything else is rethrown
 * for the app-wide error handler, which hides the details.
 */
function handleError(err, res) {
  if (err instanceof nextcloud.NextcloudError) return res.status(400).json({ error: err.message });
  throw err;
}

/**
 * Builds the router.
 * Out: an Express router; every route requires a signed-in user.
 */
function createNextcloudRouter() {
  const router = express.Router();
  router.use(requireAuth);

  // Saving and exporting make this server connect elsewhere, so they're limited
  // per person: this can't be used to hammer another machine, or to scan addresses.
  const limiter = rateLimit({
    store: new PostgresRateStore('nextcloud:'),
    windowMs: 15 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });

  /** GET /api/nextcloud — the caller's connection status. */
  router.get('/', async (req, res) => {
    const { rows } = await pool.query('select * from nextcloud_links where user_id = $1', [req.user.id]);
    res.json(publicLink(rows[0]));
  });

  /**
   * PUT /api/nextcloud — saves the caller's connection after testing that it works.
   * In: { baseUrl, username, appPassword, dailyExport }. Out: the connection status.
   * Side effects: connects to that Nextcloud; stores the password encrypted.
   */
  router.put('/', limiter, async (req, res) => {
    const { baseUrl, username, appPassword, dailyExport = true } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 200) {
      return res.status(400).json({ error: 'Enter your Nextcloud user name.' });
    }
    if (typeof appPassword !== 'string' || !appPassword || appPassword.length > 500) {
      return res.status(400).json({ error: 'Enter a Nextcloud app password.' });
    }
    try {
      const cleanUrl = nextcloud.checkBaseUrl(baseUrl);
      const link = { baseUrl: cleanUrl, username: username.trim(), password: appPassword };
      await nextcloud.testConnection(link);
      // That test waits on a server the caller chose, so it can be held open on purpose. If the password
      // changed meanwhile, this request's session is over, and saving now would restore the link that the
      // change removed. So the session is checked again here, in the same transaction as the save.
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (!(await sessionStillValid(client, req.user.id, req.token))) {
          await client.query('rollback');
          return res.status(401).json({ error: 'Please sign in.' });
        }
        const { rows } = await client.query(
          `insert into nextcloud_links (user_id, base_url, username, app_password_enc, daily_export)
           values ($1, $2, $3, $4, $5)
           on conflict (user_id) do update set base_url = excluded.base_url, username = excluded.username,
             app_password_enc = excluded.app_password_enc, daily_export = excluded.daily_export,
             last_error = null, updated_at = now()
           returning *`,
          [req.user.id, cleanUrl, link.username, encrypt(appPassword), dailyExport === true]
        );
        await client.query('commit');
        return res.json(publicLink(rows[0]));
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return handleError(err, res);
    }
  });

  /**
   * PATCH /api/nextcloud — turns the caller's daily export on or off.
   * In: { dailyExport }. Out: the connection status.
   */
  router.patch('/', async (req, res) => {
    if (typeof req.body?.dailyExport !== 'boolean') return res.status(400).json({ error: 'Bad setting.' });
    const { rows } = await pool.query(
      'update nextcloud_links set daily_export = $2, updated_at = now() where user_id = $1 returning *',
      [req.user.id, req.body.dailyExport]
    );
    return res.json(publicLink(rows[0]));
  });

  /**
   * DELETE /api/nextcloud — disconnects, destroying the stored password. Files
   * already saved in Nextcloud are left where they are.
   */
  router.delete('/', async (req, res) => {
    await pool.query('delete from nextcloud_links where user_id = $1', [req.user.id]);
    res.json({ connected: false });
  });

  /**
   * POST /api/nextcloud/export — exports the caller's library now.
   * Out: the updated connection status, or 400 with the reason it failed.
   */
  router.post('/export', limiter, async (req, res) => {
    try {
      await nextcloud.exportForUser(req.user.id);
      const { rows } = await pool.query('select * from nextcloud_links where user_id = $1', [req.user.id]);
      return res.json(publicLink(rows[0]));
    } catch (err) {
      return handleError(err, res);
    }
  });

  return router;
}

module.exports = { createNextcloudRouter };
