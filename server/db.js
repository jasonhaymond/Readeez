// db.js
// The server's shared connection pool to Postgres. Every other file runs its SQL
// through this. All queries in this project are hand-written and pass values as
// numbered parameters ($1, $2), which is what stops SQL injection: the database
// treats those values as data, never as part of the command.

const { Pool, types } = require('pg');

// Postgres "date" columns (type number 1082) arrive as plain 'YYYY-MM-DD' text
// instead of being converted to a JavaScript Date, which would shift a book's
// read date by a day depending on the server's time zone.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = pool;
