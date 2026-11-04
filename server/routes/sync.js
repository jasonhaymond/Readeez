// routes/sync.js
// POST /api/sync: the one route that moves books between a phone and the server.
// The phone sends what changed locally and receives what changed elsewhere.
//
// When the same book was edited on two devices, the edit with the later time wins
// and the other is discarded (last edit wins). Reads and writes the books table.
//
// Every query filters on the signed-in user's id. Without that, anyone signed in
// could read or overwrite another family member's books by sending their ids.

const express = require('express');
const pool = require('../db');
const { validateBook, UUID } = require('../bookValidation');

const MAX_CHANGES = 500;
const PULL_LIMIT = 1000;
// A sync position: digits only, short enough to fit a Postgres bigint.
const CURSOR = /^\d{1,18}$/;

/**
 * Converts a database row into the JSON shape phones use.
 * In: a books row. Out: the book as the client stores it.
 */
function rowToBook(row) {
  return {
    id: row.id,
    title: row.title,
    authors: row.authors,
    categories: row.categories,
    status: row.status,
    rating: row.rating,
    readDate: row.read_date,
    notes: row.notes,
    updatedAt: row.updated_at.toISOString(),
    deleted: row.deleted,
  };
}

/**
 * Builds the sync router.
 * Out: an Express router handling POST /. app.js checks the sign-in before this runs.
 */
function createSyncRouter() {
  const router = express.Router();

  /**
   * POST /api/sync — signed-in users, on their own books only.
   * In: { cursor, epoch, changes: [book, ...] }. The cursor is the position returned
   * by the last sync, or "0" the first time. The epoch is the id returned by the last
   * sync, absent the first time.
   * Out: { cursor, epoch, more, reset, changes: [book, ...], rejected: [{ id, error }] }.
   * "more" means another sync is needed to catch up. "reset" means the server was restored
   * from a backup since this phone last synced, so positions from before don't apply.
   * Side effects: inserts or updates books.
   */
  router.post('/', async (req, res) => {
    const { cursor = '0', changes = [], epoch } = req.body || {};
    if (typeof cursor !== 'string' || !CURSOR.test(cursor)) return res.status(400).json({ error: 'Bad cursor.' });
    if (epoch !== undefined && (typeof epoch !== 'string' || !UUID.test(epoch))) return res.status(400).json({ error: 'Bad epoch.' });
    // Bounded so one request can't tie up the server; the app sends in batches.
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES) return res.status(400).json({ error: 'Bad changes.' });

    const now = new Date();
    const rejected = [];
    const valid = [];
    // A single bad book is reported rather than failing the request, so it can't
    // stop every other book on the phone from syncing.
    for (const change of changes) {
      const { book, error } = validateBook(change, now);
      if (book) valid.push(book);
      else rejected.push({ id: typeof change?.id === 'string' ? change.id.slice(0, 64) : null, error });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');
      // Lets one sync run at a time per person, released at commit. Change numbers
      // must become visible in order: without this, one sync could finish with a
      // higher number first, a phone would remember it, and the lower-numbered
      // change would never reach that phone.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [req.user.id]);

      // Changes that lost to a newer edit go back, so the phone drops its old copy.
      const lostIds = [];
      for (const book of valid) {
        // Inserts the book, or updates it only if this edit is strictly newer. The
        // primary key includes user_id, so the same id from another account is a
        // separate row and can't touch this person's book.
        const { rowCount } = await client.query(
          `insert into books (user_id, id, title, authors, categories, status, rating, read_date, notes, updated_at, deleted)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (user_id, id) do update set
             title = excluded.title, authors = excluded.authors, categories = excluded.categories,
             status = excluded.status, rating = excluded.rating, read_date = excluded.read_date,
             notes = excluded.notes, updated_at = excluded.updated_at, deleted = excluded.deleted,
             seq = nextval('books_seq')
           where excluded.updated_at > books.updated_at`,
          [req.user.id, book.id, book.title, book.authors, book.categories, book.status, book.rating,
            book.readDate, book.notes, book.updatedAt, book.deleted]
        );
        if (rowCount === 0) lostIds.push(book.id);
      }

      // Detects a restore in two ways, and starts again from zero if either applies. A changed
      // epoch is the reliable one: restore.sh sets a new one. A position ahead of the numbering
      // catches a database restored by hand without restore.sh.
      const { rows: [{ last_value: lastSeq }] } = await client.query('select last_value from books_seq');
      const { rows: [meta] } = await client.query('select sync_epoch from app_meta where id = 1');
      const serverEpoch = meta ? meta.sync_epoch : null;
      const reset = BigInt(cursor) > BigInt(lastSeq) || Boolean(epoch && serverEpoch && epoch.toLowerCase() !== serverEpoch);
      const from = reset ? '0' : cursor;

      // Everything of this person's since their position, in change order. One
      // extra row is fetched just to learn whether more remain.
      const { rows } = await client.query(
        `select * from books where user_id = $1 and seq > $2 order by seq limit $3`,
        [req.user.id, from, PULL_LIMIT + 1]
      );
      const more = rows.length > PULL_LIMIT;
      const page = rows.slice(0, PULL_LIMIT);
      const nextCursor = page.length ? page[page.length - 1].seq : from;

      // The current versions of books whose incoming edit lost, unless they're in
      // the page already. These can sit behind the phone's position, so the normal
      // pull above wouldn't include them.
      const inPage = new Set(page.map((row) => row.id));
      const missing = lostIds.filter((id) => !inPage.has(id));
      const lost = missing.length
        ? (await client.query('select * from books where user_id = $1 and id = any($2::uuid[])', [req.user.id, missing])).rows
        : [];
      await client.query('commit');

      return res.json({
        cursor: String(nextCursor),
        epoch: serverEpoch,
        more,
        reset,
        changes: [...page, ...lost].map(rowToBook),
        rejected,
      });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { createSyncRouter };
