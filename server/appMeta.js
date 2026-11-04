// appMeta.js
// Records which app version is running in the database itself, on every start.
// A database dump is therefore self-describing: backup.sh reads this row to name
// each backup after the version it was really taken from, and after a restore the
// row shows which version's data came back.

const pool = require('./db');
const { version } = require('./package.json');

/**
 * Saves this process's version in the single app_meta row.
 * In: nothing. Out: nothing. Side effects: writes that one row.
 */
async function recordAppVersion() {
  // "on conflict" turns the insert into an update once the row exists (an upsert).
  await pool.query(
    `insert into app_meta (id, app_version, updated_at) values (1, $1, now())
     on conflict (id) do update set app_version = excluded.app_version, updated_at = excluded.updated_at`,
    [version]
  );
}

module.exports = { recordAppVersion, version };
