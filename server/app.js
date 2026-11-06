// app.js
// Assembles the web server: security headers, CORS, request size limits, the health
// check, every route, and the catch-all error handler. Kept apart from index.js so
// the tests can run it without opening a network port or starting background timers.

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit').default;
const helmet = require('helmet');
const pool = require('./db');
const { createAuthRouter } = require('./routes/auth');
const { createSyncRouter } = require('./routes/sync');
const { requireAuth } = require('./auth');
const { PostgresRateStore } = require('./rateLimitStore');
const { createAdminRouter } = require('./routes/admin');
const { createNextcloudRouter } = require('./routes/nextcloud');
const { recordRequest } = require('./metrics');
const log = require('./logger')('http');

/**
 * Reads which web origins may call this API from a browser.
 * In: nothing (reads CORS_ALLOWED_ORIGINS, comma-separated). Out: a list of origins.
 * The Android app isn't subject to CORS, so production normally leaves this empty,
 * which means no website anywhere can call the API from a visitor's browser.
 */
function allowedOrigins() {
  return String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Builds the Express app.
 * In: optionally { syncLimit }, how many sync requests an account may make per 15 minutes. Far more than real
 * use needs: a phone syncs after edits, in batches of 200 books.
 * Out: the app, ready to listen or to be tested. Touches nothing until it's used.
 */
function createApp({ syncLimit = 600 } = {}) {
  const app = express();

  // The reverse proxy (Caddy) connects to this server, so every request appears to
  // come from the proxy. TRUST_PROXY says how many proxies to believe when they
  // report the real client address. Rate limiting per address depends on it: too
  // low and the whole family shares one limit, too high and a client can forge its
  // address. Defaults to none, the safe answer when nothing is known.
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

  // Standard protective headers (HSTS, no MIME sniffing, no framing, and so on).
  // This server sends only JSON, so its content policy allows nothing at all.
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  }));

  // Browsers from other websites are refused unless listed. `false` adds no CORS
  // headers, so a browser won't let a page read the responses.
  const origins = allowedOrigins();
  app.use(cors({ origin: origins.length ? origins : false }));

  // Tells phones and proxies never to save these responses. Android's network layer otherwise keeps a plain-text copy
  // of answers in the app's cache folder, including people's names and emails, outside the app's own encryption, and
  // signing out doesn't clear that folder.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Logs each request's method, path and result, and counts it for the admin Server panel. Never
  // the body or the Authorization header, and originalUrl is cut at the "?" in case a query string
  // holds anything.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      recordRequest(res.statusCode, Date.now() - started);
      log.info(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode}`);
    });
    next();
  });

  /**
   * GET /api/health — public, for uptime monitors and the deploy script. Reports only
   * up or down, but really queries the database so "up" means the app can work.
   */
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('select 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Limits on request size, so an oversized body is refused before it's held in
  // memory. Sync gets more room because a batch of books with long notes is large, so it
  // checks the sign-in first: otherwise anyone at all could make the server read and parse
  // 12 MB per request, with no account.
  // The limit is per account, not per address, because a family may share one address, and it comes after
  // the sign-in check, so nobody can use up another person's allowance.
  const syncLimiter = rateLimit({
    store: new PostgresRateStore('sync:'),
    windowMs: 15 * 60 * 1000,
    limit: syncLimit,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sync requests. Please wait a few minutes.' },
  });
  app.use('/api/sync', requireAuth, syncLimiter, express.json({ limit: '12mb' }), createSyncRouter());
  app.use('/api/auth', express.json({ limit: '16kb' }), createAuthRouter());
  app.use('/api/admin', express.json({ limit: '16kb' }), createAdminRouter());
  app.use('/api/nextcloud', express.json({ limit: '16kb' }), createNextcloudRouter());

  // Anything else is a plain 404, not Express's default HTML page.
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  /**
   * The last stop for errors. Client mistakes (malformed JSON, oversized body) keep
   * their 4xx status. Everything else is logged here and answered with a generic 500,
   * so stack traces and SQL errors never reach a client. Express identifies this as an
   * error handler because it takes four parameters, so `next` must stay in the list.
   *
   * A deadlock (Postgres error 40P01) gets its own answer. It can still happen in rare crossings, such as two admins
   * each using a reset code the other made at the same moment, and ordering locks can't rule those out. Postgres
   * cancels one request and rolls back all of its work, so nothing is half-done, which makes trying again safe. The
   * retry can still be refused: if the other request finishes and cancels this person's code, as a password change
   * does for codes that account created, an admin has to issue a new one.
   */
  app.use((err, req, res, next) => {
    if (err.code === '40P01') {
      log.warn(`${req.method} ${req.originalUrl.split('?')[0]}: cancelled by a deadlock, asked the caller to retry`);
      return res.status(503).json({ error: 'The server was busy. Please try again.' });
    }
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) log.error(`${req.method} ${req.originalUrl.split('?')[0]}: ${err.message}`);
    res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : 'That request wasn\'t valid.' });
  });

  return app;
}

module.exports = { createApp };
