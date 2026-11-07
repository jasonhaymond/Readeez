// routes/lookup.js
// POST /api/lookup: title and author suggestions from online catalogues, for the add-a-book form. Signed-in family
// members only, and limited per account, because otherwise anyone could use this server to query those services and
// get it blocked. The work happens in bookLookup.js. Touches no books and stores nothing in the database.

const express = require('express');
const rateLimit = require('express-rate-limit').default;
const { requireAuth } = require('../auth');
const { lookup, LookupError } = require('../bookLookup');
const { PostgresRateStore } = require('../rateLimitStore');

const MIN_QUERY = 3;
const MAX_QUERY = 100;

/**
 * Builds the router.
 * In: optionally { limit }, how many lookups an account may make per 15 minutes. The app waits for a pause in typing,
 * so this is well above real use, even for someone adding many books in a row.
 * Out: an Express router. Every route requires a sign-in, which runs before the limit so that nobody can use up
 * another person's allowance.
 */
function createLookupRouter({ limit = 200 } = {}) {
  const router = express.Router();
  const limiter = rateLimit({
    store: new PostgresRateStore('lookup:'),
    windowMs: 15 * 60 * 1000,
    limit,
    keyGenerator: (req) => req.user.id,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many lookups. Please wait a few minutes.' },
  });

  /**
   * POST /api/lookup — signed-in users.
   * In: { kind: 'title' or 'author', query }. POST rather than GET, so the search text is never part of an address
   * that a proxy could log.
   * Out: { results, source }. results is [{ title, authors }] or [{ name }]. Answers 404 if the server's owner has
   * turned this off with BOOK_LOOKUP_ENABLED=false, and 503 if no catalogue could answer.
   */
  router.post('/', requireAuth, limiter, async (req, res) => {
    if (process.env.BOOK_LOOKUP_ENABLED === 'false') return res.status(404).json({ error: 'Online suggestions are turned off.' });
    const { kind, query } = req.body || {};
    if (kind !== 'title' && kind !== 'author') return res.status(400).json({ error: 'Bad kind.' });
    if (typeof query !== 'string') return res.status(400).json({ error: 'Bad query.' });
    // Collapses spaces, and removes control characters, which have no place in a search.
    const clean = query.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < MIN_QUERY || clean.length > MAX_QUERY) return res.status(400).json({ error: 'Bad query.' });
    try {
      return res.json(await lookup(kind, clean));
    } catch (err) {
      if (err instanceof LookupError) return res.status(503).json({ error: 'Suggestions aren\'t available right now.' });
      throw err;
    }
  });

  return router;
}

module.exports = { createLookupRouter };
