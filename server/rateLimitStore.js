// rateLimitStore.js
// Where express-rate-limit keeps its counts: in Postgres instead of its default of memory. Memory is emptied
// by a restart, so someone guessing passwords would get a fresh set of attempts each time the server restarted
// or updated. Used by every rate limiter in the app. A store is any object with these methods; the library
// calls them once per request.

const pool = require('./db');
const log = require('./logger')('rate-limit');

/**
 * One limiter's counts.
 * In: a prefix keeping this limiter's counts apart from the others', e.g. 'auth:'.
 */
class PostgresRateStore {
  constructor(prefix) {
    this.prefix = prefix;
    // Tells the library the counts are shared and outlive this object.
    this.localKeys = false;
  }

  /**
   * Called once by the library when the limiter is set up.
   * In: its options, of which only the length of the counting window matters here.
   */
  init(options) {
    this.windowMs = options.windowMs;
  }

  /**
   * Counts one more request. One atomic statement does it all, so simultaneous requests can't undercount.
   * In: the key (a network address or account id). Out: { totalHits, resetTime }.
   * Side effects: starts a new window if there's none, or if the last one has ended.
   */
  async increment(key) {
    const { rows } = await pool.query(
      `insert into rate_limits (key, hits, reset_at) values ($1, 1, now() + make_interval(secs => $2))
       on conflict (key) do update set
         hits = case when rate_limits.reset_at <= now() then 1 else rate_limits.hits + 1 end,
         reset_at = case when rate_limits.reset_at <= now() then excluded.reset_at else rate_limits.reset_at end
       returning hits, reset_at`,
      [`${this.prefix}${key}`, this.windowMs / 1000]
    );
    return { totalHits: rows[0].hits, resetTime: rows[0].reset_at };
  }

  /**
   * Takes one back. The library calls this after a successful sign-in, so normal use doesn't use up attempts.
   * In: the key. A failure is logged and goes no further: the library doesn't watch for one here, so an
   * uncaught database error would stop the whole server, and the only cost of missing this is one extra count.
   */
  async decrement(key) {
    await pool.query('update rate_limits set hits = greatest(hits - 1, 0) where key = $1', [`${this.prefix}${key}`])
      .catch((err) => log.warn(`could not take back a count: ${err.message}`));
  }

  /** Forgets a key's count entirely. In: the key. */
  async resetKey(key) {
    await pool.query('delete from rate_limits where key = $1', [`${this.prefix}${key}`]);
  }
}

/**
 * Deletes finished windows, so the table doesn't grow forever. Called hourly from index.js.
 * Side effects: removes expired rows, which count for nothing anyway.
 */
async function pruneRateLimits() {
  await pool.query('delete from rate_limits where reset_at <= now()');
}

module.exports = { PostgresRateStore, pruneRateLimits };
