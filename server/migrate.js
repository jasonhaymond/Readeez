// migrate.js
// Brings the database schema up to date when the server starts. Applies each file
// in migrations/ that hasn't run yet, in name order, and records it in
// schema_migrations. Forward-only: there are no "down" migrations, so rolling the
// schema back means restoring a backup (see docs/admin-guide.md).

const fs = require('fs');
const path = require('path');
const pool = require('./db');
const log = require('./logger')('migrate');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// An arbitrary number all Readeez processes agree on for the lock below.
const LOCK_ID = 7303001;

/**
 * Applies any migrations that haven't run.
 * In: nothing. Out: a list of the file names it applied.
 * Side effects: changes the database schema. Any failure rolls that file back and
 * throws, which stops the server from starting against a half-changed database.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    // A database-wide lock held until unlocked below, so two server processes
    // starting at once can't both apply the same migration.
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())'
    );
    const { rows } = await client.query('select name from schema_migrations');
    const done = new Set(rows.map((row) => row.name));
    // Zero-padded names (001_, 002_) sort into the order they must run in.
    const pending = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !done.has(f)).sort();

    for (const name of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      // One transaction per file: it either applies completely or not at all.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
        log.info(`applied ${name}`);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    return pending;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };
