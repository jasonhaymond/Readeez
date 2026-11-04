// test/globalSetup.js
// Runs once before all tests: starts a throwaway Postgres container, waits for it,
// and applies the real migrations. It has its own name and port, so it can't touch
// a development or production database. Jest runs this in a separate process, so the
// connection details reach the test workers through a file (see setupEnv.js).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const CONTAINER = 'readeez-test-pg';
const PORT = 15434;
const DATABASE_URL = `postgres://readeez:test@127.0.0.1:${PORT}/readeez_test`;
const ENV_FILE = path.join(__dirname, '.env.test.json');

/**
 * Waits up to 60 seconds for Postgres to accept connections.
 * Out: nothing. Throws if it never becomes ready.
 */
async function waitForPostgres() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('The Postgres test container did not become ready.');
}

/**
 * Starts the database and prepares it. Side effects: runs a Docker container, which
 * globalTeardown.js removes, and writes the settings file for the test workers.
 */
module.exports = async function globalSetup() {
  // Clears a container left behind by a crashed earlier run.
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: 'ignore' });
  } catch {
    // None was there, which is the normal case.
  }
  execSync(
    `docker run -d --rm --name ${CONTAINER} -e POSTGRES_DB=readeez_test -e POSTGRES_USER=readeez ` +
      `-e POSTGRES_PASSWORD=test -p 127.0.0.1:${PORT}:5432 postgres:18-alpine`,
    { stdio: 'ignore' }
  );
  await waitForPostgres();

  const env = {
    DATABASE_URL,
    SECRETS_KEY: 'test-only-key',
    NODE_ENV: 'test',
    // Empty, so the admin status route never contacts GitHub during tests.
    UPDATE_CHECK_REPO: '',
  };
  fs.writeFileSync(ENV_FILE, JSON.stringify(env));

  // db.js reads the address when first loaded, so it must be set before this require.
  Object.assign(process.env, env);
  const { migrate } = require('../migrate');
  const pool = require('../db');
  await migrate();
  await pool.end();
};
