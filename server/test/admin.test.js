// test/admin.test.js
// Tests the admin features: account rules (the family can't lose its last admin), the terminal panel's
// commands, the log viewer, server status, and requesting backups and updates. Each comment names what it
// protects against.

const path = require('path');
const { execFile } = require('child_process');
const request = require('supertest');
const pool = require('../db');
const accounts = require('../accounts');
const auth = require('../auth');
const { createApp } = require('../app');
const { recordAppVersion } = require('../appMeta');
const { PASSWORD, resetDb, createUser, makeBook, bearer } = require('./helpers');

let app;
beforeEach(async () => {
  await resetDb();
  await recordAppVersion();
  app = createApp();
});
afterAll(() => pool.end());

/**
 * Runs a terminal panel command the way admin.sh does, as a real separate process.
 * In: the arguments. Out: { code, stdout, stderr }.
 */
function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '../scripts/admin-cli.js'), ...args], { env: process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('keeping a working admin', () => {
  // Lockout: nothing may leave the family with nobody able to manage accounts.
  test.each([
    ['disabling', (id) => accounts.setDisabled(id, true)],
    ['demoting', (id) => accounts.setRole(id, 'member')],
    ['deleting', (id) => accounts.deleteAccount(id)],
  ])('%s the only admin is refused', async (name, action) => {
    const admin = await createUser({ role: 'admin' });
    await expect(action(admin.id)).rejects.toThrow('only working admin');
    const { rows } = await pool.query('select role, disabled_at from users where id = $1', [admin.id]);
    expect(rows[0]).toEqual({ role: 'admin', disabled_at: null });
  });

  // A disabled admin can't sign in, so doesn't count as a working one.
  test('a disabled second admin does not count', async () => {
    const admin = await createUser({ role: 'admin' });
    const other = await createUser({ role: 'admin' });
    await accounts.setDisabled(other.id, true);
    await expect(accounts.setRole(admin.id, 'member')).rejects.toThrow('only working admin');
  });

  // Race: two admins removing each other at the same moment must not leave none.
  test('two admins removing each other leaves one', async () => {
    const [a, b] = [await createUser({ role: 'admin' }), await createUser({ role: 'admin' })];
    const results = await Promise.allSettled([accounts.setRole(a.id, 'member'), accounts.setRole(b.id, 'member')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await pool.query(`select count(*)::int as n from users where role = 'admin'`);
    expect(rows[0].n).toBe(1);
  });

  // Normal behaviour with a second admin present.
  test('an admin can be removed when another remains', async () => {
    const admin = await createUser({ role: 'admin' });
    await createUser({ role: 'admin' });
    await accounts.deleteAccount(admin.id);
    expect((await pool.query('select id from users where id = $1', [admin.id])).rows).toEqual([]);
  });

  // Deleting an account really removes the person's private data.
  test('deleting an account removes its books and sessions', async () => {
    await createUser({ role: 'admin' });
    const member = await createUser();
    await request(app).post('/api/sync').set('Authorization', bearer(member.token)).send({ changes: [makeBook()] });
    await accounts.deleteAccount(member.id);
    expect((await pool.query('select id from books')).rows).toEqual([]);
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(member.token))).status).toBe(401);
  });

  // Role changes can't be used to create an unknown role.
  test('an unknown role is refused', async () => {
    const member = await createUser();
    await expect(accounts.setRole(member.id, 'superuser')).rejects.toThrow('must be');
  });
});

describe('a removed admin\'s codes', () => {
  const details = { email: 'back@example.com', displayName: 'Back Again', password: PASSWORD };
  const redeem = (code) => request(app).post('/api/auth/redeem').send({ ...details, code });

  // Persistence: an admin expecting removal keeps an admin invite code to get back in with. Each way of
  // removing them must kill it.
  test.each([
    ['disabled', (id) => accounts.setDisabled(id, true)],
    ['made a member', (id) => accounts.setRole(id, 'member')],
    ['deleted', (id) => accounts.deleteAccount(id)],
  ])('an invite from an admin who is %s stops working', async (name, removal) => {
    await createUser({ role: 'admin' });
    const leaving = await createUser({ role: 'admin' });
    const code = await auth.createInvite('admin', leaving.id);
    await removal(leaving.id);
    expect((await redeem(code)).status).toBe(400);
    expect((await pool.query(`select id from users where email = 'back@example.com'`)).rows).toEqual([]);
  });

  // Takeover: a saved reset code for another admin dies the same way.
  test('a reset code from a removed admin stops working', async () => {
    const staying = await createUser({ role: 'admin' });
    const leaving = await createUser({ role: 'admin' });
    const code = await auth.createResetCode(staying.id, leaving.id);
    await accounts.setDisabled(leaving.id, true);
    expect((await request(app).post('/api/auth/reset').send({ code, password: 'attacker-password-1' })).status).toBe(400);
  });

  // Re-enabling someone doesn't bring back codes cancelled when they were disabled.
  test('re-enabling does not revive the codes', async () => {
    await createUser({ role: 'admin' });
    const leaving = await createUser({ role: 'admin' });
    const code = await auth.createInvite('admin', leaving.id);
    await accounts.setDisabled(leaving.id, true);
    await accounts.setDisabled(leaving.id, false);
    expect((await redeem(code)).status).toBe(400);
  });

  // Another admin's codes are untouched, and a refused removal cancels nothing.
  test('other admins\' codes keep working', async () => {
    const staying = await createUser({ role: 'admin' });
    const leaving = await createUser({ role: 'admin' });
    const code = await auth.createInvite('member', staying.id);
    await accounts.setDisabled(leaving.id, true);
    await expect(accounts.setDisabled(staying.id, true)).rejects.toThrow('only working admin');
    expect((await redeem(code)).status).toBe(201);
  });
});

describe('terminal panel commands', () => {
  test('status reports counts as name and value lines', async () => {
    await createUser({ role: 'admin' });
    const { code, stdout } = await cli('status');
    expect(code).toBe(0);
    expect(stdout).toContain('users\t1');
    expect(stdout).toContain('agent_age\t-1');
  });

  // Privacy: the panel's list shows a count, never titles, notes or password hashes.
  test('the account list holds no book contents or hashes', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin@example.com', name: 'The Admin' });
    await request(app).post('/api/sync').set('Authorization', bearer(admin.token)).send({ changes: [makeBook({ title: 'Secret Diary', notes: 'private' })] });
    const { stdout } = await cli('users');
    expect(stdout).toBe('admin@example.com\tThe Admin\tadmin\tactive\t1\n');
  });

  // A printed invite code really works, with the role it was made for, and only once.
  test('an invite code from the panel works', async () => {
    const { stdout } = await cli('invite', 'member');
    const code = stdout.trim();
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    const details = { code, email: 'new@example.com', displayName: 'New', password: PASSWORD };
    const res = await request(app).post('/api/auth/redeem').send(details);
    expect(res.body.user.role).toBe('member');
    expect((await request(app).post('/api/auth/redeem').send({ ...details, email: 'x@example.com' })).status).toBe(400);
  });

  test('a reset code from the panel works', async () => {
    await createUser({ email: 'sam@example.com' });
    const { stdout } = await cli('reset', 'SAM@example.com');
    const res = await request(app).post('/api/auth/reset').send({ code: stdout.trim(), password: 'a-brand-new-password' });
    expect(res.status).toBe(200);
  });

  // Disabling through the panel takes effect at once on a signed-in phone.
  test('disable and enable work by email', async () => {
    await createUser({ role: 'admin' });
    const member = await createUser({ email: 'sam@example.com' });
    expect((await cli('disable', 'sam@example.com')).code).toBe(0);
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(member.token))).status).toBe(401);
    expect((await cli('enable', 'sam@example.com')).code).toBe(0);
    expect((await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD })).status).toBe(200);
  });

  // The panel follows the same last-admin rule as the app, and reports failures with an exit code.
  test('the last admin rule applies, with a readable error', async () => {
    await createUser({ role: 'admin', email: 'admin@example.com' });
    const { code, stderr } = await cli('delete', 'admin@example.com');
    expect(code).toBe(1);
    expect(stderr).toContain('only working admin');
  });

  // SQL injection through a command argument changes nothing.
  test('hostile arguments are harmless', async () => {
    await createUser({ email: 'sam@example.com' });
    const { code } = await cli('delete', "x' or '1'='1");
    expect(code).toBe(1);
    expect((await pool.query('select count(*)::int as n from users')).rows[0].n).toBe(1);
  });

  test.each([[['invite', 'superuser']], [['unknown-command']], [['reset', 'nobody@example.com']]])('%j fails cleanly', async (args) => {
    expect((await cli(...args)).code).toBe(1);
  });
});

describe('log viewer', () => {
  let admin;
  const logs = (query = '') => request(app).get(`/api/admin/logs${query}`).set('Authorization', bearer(admin.token));
  beforeEach(async () => { admin = await createUser({ role: 'admin' }); });

  test('it returns recent lines, newest first, in the standard format', async () => {
    await request(app).get('/api/health');
    await request(app).get('/api/this-route-is-missing');
    const { body } = await logs();
    expect(body.lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* INFO \[http\] GET \/api\/admin\/logs|GET \/api\/this-route-is-missing 404/);
    expect(body.lines.some((line) => line.includes('/api/this-route-is-missing 404'))).toBe(true);
  });

  test('it filters by level', async () => {
    const createLogger = require('../logger');
    createLogger('test').warn('a warning line');
    createLogger('test').info('an info line');
    const { body } = await logs('?level=warn');
    expect(body.lines.join('\n')).toContain('a warning line');
    expect(body.lines.join('\n')).not.toContain('an info line');
  });

  // Input handling: bad filters and huge limits are refused or capped.
  test('bad parameters are handled', async () => {
    expect((await logs('?level=everything')).status).toBe(400);
    expect((await logs('?limit=99999999')).status).toBe(200);
    expect((await logs('?limit=abc')).status).toBe(200);
  });

  // Secrets must never reach an admin's screen through the logs either.
  test('a full sign-in and sync leave no secrets in the viewer', async () => {
    await createUser({ email: 'sam@example.com' });
    const login = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    await request(app).post('/api/sync').set('Authorization', bearer(login.body.token)).send({ changes: [makeBook({ notes: 'very-private-note' })] });
    const text = (await logs('?limit=500')).body.lines.join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(login.body.token);
    expect(text).not.toContain('very-private-note');
  });
});

describe('server status', () => {
  // The panel reports whether the helper is alive, and request counters.
  test('it reports helper state and metrics', async () => {
    const admin = await createUser({ role: 'admin' });
    const get = () => request(app).get('/api/admin/status').set('Authorization', bearer(admin.token));
    expect((await get()).body.agentRunning).toBe(false);
    await pool.query('update app_meta set agent_seen_at = now()');
    const { body } = await get();
    expect(body.agentRunning).toBe(true);
    expect(body.metrics.requests).toBeGreaterThan(0);
    expect(body.metrics).toHaveProperty('averageMs');
  });
});

describe('requesting jobs', () => {
  let admin;
  const job = (body) => request(app).post('/api/admin/jobs').set('Authorization', bearer(admin.token)).send(body);
  const helperOn = () => pool.query('update app_meta set agent_seen_at = now()');
  beforeEach(async () => { admin = await createUser({ role: 'admin' }); });

  // Normal behaviour: a request is only queued, recording who asked.
  test('a backup job is queued', async () => {
    await helperOn();
    const res = await job({ kind: 'backup' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    const { rows } = await pool.query('select requested_by from admin_jobs');
    expect(rows[0].requested_by).toBe(admin.id);
  });

  // With no helper, a job would sit forever, so the admin is told at once instead.
  test('a job is refused when the helper is not running', async () => {
    expect((await job({ kind: 'backup' })).status).toBe(409);
    await pool.query(`update app_meta set agent_seen_at = now() - interval '10 minutes'`);
    expect((await job({ kind: 'backup' })).status).toBe(409);
  });

  // An update needs the typed confirmation, even from a client that skips the dialog.
  test('an update needs the typed confirmation', async () => {
    await helperOn();
    expect((await job({ kind: 'update', version: 'v1.2.3' })).status).toBe(400);
    expect((await job({ kind: 'update', version: 'v1.2.3', confirm: 'yes' })).status).toBe(400);
    expect((await job({ kind: 'update', version: 'v1.2.3', confirm: 'UPDATE' })).status).toBe(201);
  });

  // Command injection: this value later reaches a script on the host, so only an exact version shape
  // may ever be stored.
  test.each(['$(reboot)', 'v1.0.0; rm -rf /', '--help', 'main', 'v1.0', '../v1.0.0', '', null, 5])('version %j is refused', async (version) => {
    await helperOn();
    expect((await job({ kind: 'update', version, confirm: 'UPDATE' })).status).toBe(400);
    expect((await pool.query('select id from admin_jobs')).rows).toEqual([]);
  });

  // Only the two allowed kinds exist, including at the database level.
  test('unknown kinds are refused', async () => {
    await helperOn();
    expect((await job({ kind: 'shell', arg: 'reboot' })).status).toBe(400);
    await expect(pool.query(`insert into admin_jobs (kind) values ('shell')`)).rejects.toThrow();
  });

  // Double taps and two admins: only one job can be unfinished at a time.
  test('a second job is refused while one is unfinished', async () => {
    await helperOn();
    expect((await job({ kind: 'backup' })).status).toBe(201);
    expect((await job({ kind: 'backup' })).status).toBe(409);
    await pool.query(`update admin_jobs set status = 'succeeded'`);
    expect((await job({ kind: 'backup' })).status).toBe(201);
  });

  // The same rule holds under simultaneous requests, because the database enforces it.
  test('simultaneous requests create only one job', async () => {
    await helperOn();
    const results = await Promise.all([1, 2, 3, 4].map(() => job({ kind: 'backup' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });
});
