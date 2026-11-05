// routes/admin.js
// Admin-only routes under /api/admin: family accounts, invite and reset codes, server status, the
// log viewer, and requesting a backup or update. Used by Settings > Family and Settings > Server in
// the app. Book contents are never returned here. An admin could still sign in as someone by redeeming
// a reset code for them, so using a reset code is recorded and shown to that person at next sign-in.

const express = require('express');
const pool = require('../db');
const auth = require('../auth');
const accounts = require('../accounts');
const metrics = require('../metrics');
const createLogger = require('../logger');
const { UUID } = require('../bookValidation');
const { version } = require('../appMeta');
const { latestVersion, isNewer } = require('../updateCheck');

const log = createLogger('admin');
// A release version such as v1.2.3. Anything else can't be requested as an update.
const VERSION_TAG = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// How recently the host helper must have checked in to count as running. It runs every minute.
const AGENT_FRESH_MS = 3 * 60 * 1000;
// Log viewer filters, from the app's choice to the logger's level names.
const LOG_LEVELS = new Map([['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]);
const MAX_LOG_LINES = 500;

/**
 * Sends an AccountError back as a 400 with its message. Anything else goes to the app-wide error
 * handler, which hides the details.
 */
function handleAccountError(err, res) {
  if (err instanceof accounts.AccountError) return res.status(400).json({ error: err.message });
  throw err;
}

/**
 * Converts a job row into what the app sees.
 * In: a row or undefined. Out: the job, or null.
 */
function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    version: row.arg,
    status: row.status,
    output: row.output,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/**
 * Builds the router.
 * Out: an Express router. Every route requires a signed-in admin; anyone else gets 401 or 403 before
 * any handler below runs.
 */
function createAdminRouter() {
  const router = express.Router();
  router.use(auth.requireAuth, auth.requireAdmin);

  /** GET /api/admin/users — every account, with a book count but no book contents. */
  router.get('/users', async (req, res) => {
    res.json({ users: await accounts.listAccounts() });
  });

  /**
   * POST /api/admin/invites — makes an invite code for a new family member.
   * In: { role }, 'member' unless 'admin' is given. Out: { code, expiresInDays }.
   * The code can't be shown again; only its hash is stored.
   */
  router.post('/invites', async (req, res) => {
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    const code = await auth.createInvite(role, req.user.id);
    log.info(`invite created by user ${req.user.id} for role ${role}`);
    res.status(201).json({ code, role, expiresInDays: 7 });
  });

  /**
   * POST /api/admin/users/:id/reset-code — makes a password-reset code for someone who's locked out.
   * Out: { code, expiresInHours }, shown only once.
   * Side effects: cancels that person's earlier unused reset codes. Whoever redeems the code can sign in
   * as that person, which is why redeeming it leaves a notice they'll see (see routes/auth.js).
   */
  router.post('/users/:id/reset-code', async (req, res) => {
    // Checks the id's format first, so a bad one gets a 400 and not a database error.
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad account id.' });
    const { rows } = await pool.query('select id from users where id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No such account.' });
    const code = await auth.createResetCode(rows[0].id, req.user.id);
    log.info(`reset code created by user ${req.user.id} for user ${rows[0].id}`);
    return res.status(201).json({ code, expiresInHours: 24 });
  });

  /**
   * PATCH /api/admin/users/:id — disables or re-enables an account.
   * In: { disabled: true or false }. Out: { ok: true }.
   * Side effects: see accounts.setDisabled. An admin can't disable themselves here, which stops a
   * mistaken tap from locking them out of the screen they'd need to undo it.
   */
  router.patch('/users/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad account id.' });
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'Bad setting.' });
    if (req.params.id.toLowerCase() === req.user.id) return res.status(400).json({ error: 'You can\'t disable your own account.' });
    try {
      await accounts.setDisabled(req.params.id, req.body.disabled);
    } catch (err) {
      return handleAccountError(err, res);
    }
    log.info(`user ${req.params.id} ${req.body.disabled ? 'disabled' : 'enabled'} by user ${req.user.id}`);
    return res.json({ ok: true });
  });

  /**
   * GET /api/admin/status — what's running, whether an update exists, how the last backup went,
   * whether the host helper is alive, and request counters. The update check needs the internet; if it
   * fails, latestVersion is null and the rest still answers.
   */
  router.get('/status', async (req, res) => {
    const { rows: [counts] } = await pool.query(
      `select (select count(*)::int from users) as users,
              (select count(*)::int from books where not deleted) as books`
    );
    const { rows: backups } = await pool.query(
      'select finished_at, ok, app_version, file_name, uploaded, message from backup_runs order by id desc limit 1'
    );
    const { rows: goodBackups } = await pool.query('select max(finished_at) as at from backup_runs where ok');
    const { rows: [meta] } = await pool.query('select agent_seen_at from app_meta where id = 1');
    const { rows: jobs } = await pool.query('select * from admin_jobs order by id desc limit 1');
    const latest = await latestVersion();
    const last = backups[0];
    const seen = meta?.agent_seen_at;
    res.json({
      version,
      latestVersion: latest,
      updateAvailable: Boolean(latest && isNewer(latest, version)),
      users: counts.users,
      books: counts.books,
      lastBackup: last ? {
        finishedAt: last.finished_at.toISOString(), ok: last.ok, appVersion: last.app_version,
        fileName: last.file_name, uploaded: last.uploaded, message: last.message,
      } : null,
      lastGoodBackupAt: goodBackups[0].at ? goodBackups[0].at.toISOString() : null,
      agentRunning: Boolean(seen && Date.now() - seen.getTime() < AGENT_FRESH_MS),
      job: publicJob(jobs[0]),
      metrics: metrics.snapshot(),
    });
  });

  /**
   * GET /api/admin/logs — the newest server log lines, for the in-app viewer. Admin only, since logs
   * hold internal detail such as account ids and error messages.
   * In: ?level=info|warn|error (that level and worse) and ?limit=. Out: { lines }, newest first.
   */
  router.get('/logs', (req, res) => {
    const level = LOG_LEVELS.get(String(req.query.level || 'info'));
    if (!level) return res.status(400).json({ error: 'Bad level.' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), MAX_LOG_LINES);
    return res.json({ lines: createLogger.recentLogs(level, limit) });
  });

  /**
   * POST /api/admin/jobs — asks the host helper to run a backup or an update.
   * In: { kind: 'backup' } or { kind: 'update', version: 'v1.2.3', confirm: 'UPDATE' }. An update must
   * have the typed confirmation. Out: the queued job.
   * This only writes a request. host-agent.sh runs the same scripts as the command line, so their
   * safety checks still apply, including refusing any version without a recorded security approval.
   * Answers 409 if the helper isn't running, or if a job is already underway.
   */
  router.post('/jobs', async (req, res) => {
    const { kind, version: target, confirm } = req.body || {};
    if (kind !== 'backup' && kind !== 'update') return res.status(400).json({ error: 'Bad job.' });
    if (kind === 'update') {
      if (confirm !== 'UPDATE') return res.status(400).json({ error: 'Type UPDATE to confirm.' });
      if (typeof target !== 'string' || !VERSION_TAG.test(target)) return res.status(400).json({ error: 'Bad version.' });
    }
    const { rows: [meta] } = await pool.query('select agent_seen_at from app_meta where id = 1');
    if (!meta?.agent_seen_at || Date.now() - meta.agent_seen_at.getTime() >= AGENT_FRESH_MS) {
      return res.status(409).json({ error: 'The server\'s helper isn\'t running. Use the terminal admin panel: server/admin.sh' });
    }
    try {
      const { rows } = await pool.query(
        'insert into admin_jobs (kind, arg, requested_by) values ($1, $2, $3) returning *',
        [kind, kind === 'update' ? target : null, req.user.id]
      );
      log.info(`${kind} job ${rows[0].id} requested by user ${req.user.id}`);
      return res.status(201).json(publicJob(rows[0]));
    } catch (err) {
      // 23505 is Postgres's "unique" error: the index allowing only one unfinished job refused it.
      if (err.code === '23505') return res.status(409).json({ error: 'Another job is already running. Try again when it finishes.' });
      throw err;
    }
  });

  return router;
}

module.exports = { createAdminRouter };
