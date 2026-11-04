// test/config.test.js
// Tests for transport and configuration security (headers, CORS), data leaks through
// errors and logs, export-file safety, the health check, version tracking, and
// migrations.

const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { migrate } = require('../migrate');
const { recordAppVersion, version } = require('../appMeta');
const { toCsv, toJson } = require('../exportFormat');
const { isNewer } = require('../updateCheck');
const { PASSWORD, resetDb, createUser, makeBook, bearer } = require('./helpers');

let app;
beforeEach(async () => {
  await resetDb();
  app = createApp();
});
afterAll(() => pool.end());

describe('security headers', () => {
  // Downgrade, clickjacking and MIME-sniffing protections are on every response, and
  // the framework isn't advertised to attackers.
  test('protective headers are present', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  afterEach(() => { delete process.env.CORS_ALLOWED_ORIGINS; });

  // A malicious website can't call this API from a visitor's browser by default.
  test('a foreign origin gets no CORS permission', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://attacker.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // When an origin is listed, only that one is allowed.
  test('only a listed origin is allowed', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://allowed.example';
    const listed = createApp();
    const res = await request(listed).get('/api/health').set('Origin', 'https://allowed.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example');
    const other = await request(listed).get('/api/health').set('Origin', 'https://attacker.example');
    expect(other.headers['access-control-allow-origin']).not.toBe('https://attacker.example');
  });
});

describe('data leaks', () => {
  // A crash must not reveal SQL, table names or stack traces to the client.
  test('a server error returns no internal details', async () => {
    const admin = await createUser({ role: 'admin' });
    // The sign-in check (the first query) really runs; the route's own query then fails.
    const realQuery = pool.query.bind(pool);
    let calls = 0;
    const spy = jest.spyOn(pool, 'query').mockImplementation((...args) => {
      calls += 1;
      return calls === 1 ? realQuery(...args) : Promise.reject(new Error('connection to secret-db-host:5432 failed'));
    });
    const res = await request(app).get('/api/admin/users').set('Authorization', bearer(admin.token));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-db-host');
  });

  // Secrets must never reach the logs. Logging is turned on for this test, then a full
  // sign-in and sync run, and all output is searched.
  test('passwords, tokens and book contents are not logged', async () => {
    const output = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((text) => { output.push(String(text)); return true; });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((text) => { output.push(String(text)); return true; });
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await createUser({ email: 'sam@example.com' });
      const login = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
      await request(app).post('/api/sync').set('Authorization', bearer(login.body.token))
        .send({ changes: [makeBook({ notes: 'very-private-note' })] });
      const text = output.join('');
      expect(text).toContain('/api/auth/login');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(login.body.token);
      expect(text).not.toContain('very-private-note');
    } finally {
      process.env.NODE_ENV = env;
      out.mockRestore();
      err.mockRestore();
    }
  });

  // Sign-in responses must not include the password hash.
  test('a sign-in response has no password hash', async () => {
    await createUser({ email: 'sam@example.com' });
    const res = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|password/i);
  });
});

describe('health check', () => {
  // Reachable without signing in, for uptime monitors, and revealing only up or down.
  test('it answers without a sign-in and says only up or down', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  // "Up" must mean the database works, not just that the process is running.
  test('it reports unavailable when the database fails', async () => {
    const spy = jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('down'));
    const res = await request(app).get('/api/health');
    spy.mockRestore();
    expect(res.status).toBe(503);
  });
});

describe('CSV exports', () => {
  // CSV formula injection: a note written to run when the file is opened in a spreadsheet
  // has to come out as plain text.
  test.each(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd'])('%j is neutralised', (attack) => {
    const line = toCsv([makeBook({ title: attack })]).split('\r\n')[1];
    expect(line.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  // Commas, quotes and line breaks in a note stay inside their one cell.
  test('special characters stay inside their cell', () => {
    const csv = toCsv([makeBook({ title: 'A, "B"', notes: 'line1\nline2' })]);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain('"line1\nline2"');
  });

  // Deleted books stay out of both formats.
  test('deleted books are left out', () => {
    const books = [makeBook({ title: 'Live' }), makeBook({ title: 'Gone', deleted: true })];
    expect(toCsv(books)).not.toContain('Gone');
    expect(toJson(books, '1.0.0', 'now')).not.toContain('Gone');
  });
});

describe('version tracking', () => {
  // The database records which version is running, which is how backups get named.
  test('starting up records the version, and repeats safely', async () => {
    await recordAppVersion();
    await recordAppVersion();
    const { rows } = await pool.query('select app_version from app_meta');
    expect(rows).toEqual([{ app_version: version }]);
  });

  // Version comparison must be numeric: 1.10.0 is newer than 1.9.0.
  test('versions compare by number', () => {
    expect(isNewer('v1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });
});

describe('migrations', () => {
  // Restarting must not reapply migrations.
  test('running migrations again applies nothing', async () => {
    expect(await migrate()).toEqual([]);
  });
});
