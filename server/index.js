// index.js
// The server's starting point: checks required settings, updates the database,
// records the running version, starts listening, and starts the hourly check for
// people's daily Nextcloud exports.

require('dotenv').config({ quiet: true });

const { migrate } = require('./migrate');
const { recordAppVersion, version } = require('./appMeta');
const { createApp } = require('./app');
const { runDueExports } = require('./nextcloud');
const { pruneRateLimits } = require('./rateLimitStore');
const log = require('./logger')('server');

const EXPORT_CHECK_MS = 60 * 60 * 1000;

/**
 * Starts everything. Stops with an error when a required setting is missing, because
 * a half-configured server is worse than one that refuses to start.
 * Side effects: changes the database schema if needed, and opens the network port.
 */
async function main() {
  for (const name of ['DATABASE_URL', 'SECRETS_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is not set. See .env.example.`);
  }
  await migrate();
  await recordAppVersion();

  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => log.info(`Readeez server v${version} listening on port ${port}`));

  // A failed run is logged and tried again next hour; it must not stop the server.
  const runExports = () => runDueExports().catch((err) => log.error(`export run failed: ${err.message}`));
  setInterval(runExports, EXPORT_CHECK_MS);
  // Clears finished rate-limit windows on the same hourly timer. Failing here changes nothing that matters.
  setInterval(() => pruneRateLimits().catch((err) => log.warn(`rate limit cleanup failed: ${err.message}`)), EXPORT_CHECK_MS);
  runExports();
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
