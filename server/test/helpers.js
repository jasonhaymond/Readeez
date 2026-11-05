// test/helpers.js
// Shared test tools: emptying the database, creating signed-in accounts, and
// building valid book objects.

const crypto = require('crypto');
const pool = require('../db');
const auth = require('../auth');

const PASSWORD = 'correct-horse-battery';

/** Empties every data table, so no test can depend on another's leftovers. */
async function resetDb() {
  await pool.query('truncate users, sessions, access_codes, books, nextcloud_links, app_meta, backup_runs, admin_jobs, rate_limits cascade');
}

/**
 * Creates an account and signs it in, going straight to the database for speed.
 * In: optional { email, role, name }. Out: { id, email, token }.
 */
async function createUser({ email = `${crypto.randomUUID()}@example.com`, role = 'member', name = 'Test Person' } = {}) {
  const { rows } = await pool.query(
    'insert into users (email, display_name, password_hash, role) values ($1, $2, $3, $4) returning id',
    [email, name, await auth.hashPassword(PASSWORD), role]
  );
  return { id: rows[0].id, email, token: await auth.createSession(rows[0].id) };
}

/**
 * Builds a valid book as a phone would send it.
 * In: fields to override. Out: the book object.
 */
function makeBook(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    title: 'A Book',
    authors: ['An Author'],
    categories: ['Fiction'],
    status: 'finished',
    rating: 4,
    readDate: '2026-11-04',
    notes: 'Good.',
    updatedAt: '2026-11-04T12:00:00.000Z',
    deleted: false,
    ...overrides,
  };
}

// The Authorization header a phone sends.
const bearer = (token) => `Bearer ${token}`;

module.exports = { PASSWORD, resetDb, createUser, makeBook, bearer };
