// test/ratelimit.test.js
// Security tests for rate limits: counts have to survive a server restart, and signed-in sync has a limit too.
// A "restart" here is a brand-new app, which is what a restarted process builds. Nothing in memory carries over.

const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { pruneRateLimits } = require('../rateLimitStore');
const { PASSWORD, resetDb, createUser, makeBook, bearer } = require('./helpers');

beforeEach(resetDb);
afterAll(() => pool.end());

const wrongLogin = (app, n) => request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: `wrong-${n}` });

describe('sign-in limits', () => {
  // Brute force: restarting used to reset the count, so an attacker who could wait for an update or crash
  // got fresh attempts. Even the right password is refused until the window ends.
  test('the count survives a restart', async () => {
    await createUser({ email: 'sam@example.com' });
    const before = createApp();
    for (let i = 0; i < 10; i += 1) await wrongLogin(before, i);
    const afterRestart = createApp();
    const res = await request(afterRestart).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    expect(res.status).toBe(429);
  });

  // The limit must end, or a typo would lock someone out for good.
  test('the count starts over when the window ends', async () => {
    await createUser({ email: 'sam@example.com' });
    const app = createApp();
    for (let i = 0; i < 10; i += 1) await wrongLogin(app, i);
    await pool.query(`update rate_limits set reset_at = now() - interval '1 second'`);
    const res = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  // Normal use: successful sign-ins mustn't use up attempts.
  test('successful sign-ins do not count', async () => {
    await createUser({ email: 'sam@example.com' });
    const app = createApp();
    for (let i = 0; i < 12; i += 1) {
      expect((await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD })).status).toBe(200);
    }
    const { rows } = await pool.query('select hits from rate_limits');
    expect(rows[0].hits).toBe(0);
  });

  // Undercounting: simultaneous attempts must all be counted, or a burst could beat the limit.
  test('simultaneous attempts are all counted', async () => {
    await createUser({ email: 'sam@example.com' });
    const app = createApp();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => wrongLogin(app, i)));
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
  });

  // Data handling: the table holds no passwords, emails or tokens.
  test('nothing sensitive is stored in the counts', async () => {
    await createUser({ email: 'sam@example.com' });
    await wrongLogin(createApp(), 'secret-guess');
    const text = JSON.stringify((await pool.query('select * from rate_limits')).rows);
    expect(text).not.toContain('secret-guess');
    expect(text).not.toContain('sam@example.com');
  });

  // Housekeeping removes finished windows only, so pruning can't reset an active limit.
  test('pruning removes only finished windows', async () => {
    await pool.query(`insert into rate_limits (key, hits, reset_at) values ('old', 9, now() - interval '1 minute'), ('active', 9, now() + interval '1 minute')`);
    await pruneRateLimits();
    expect((await pool.query('select key from rate_limits')).rows).toEqual([{ key: 'active' }]);
  });
});

describe('sync limit', () => {
  const sync = (app, user) => request(app).post('/api/sync').set('Authorization', bearer(user.token)).send({ cursor: '0' });

  // Abuse by a signed-in account: past the limit, sync is refused with a clear status the app can show.
  test('sync is refused past the limit', async () => {
    const user = await createUser();
    const app = createApp({ syncLimit: 3 });
    for (let i = 0; i < 3; i += 1) expect((await sync(app, user)).status).toBe(200);
    expect((await sync(app, user)).status).toBe(429);
  });

  // One person's heavy use can't lock out the rest of the family, who may share a network address.
  test('the limit is per account', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const app = createApp({ syncLimit: 2 });
    await sync(app, a);
    await sync(app, a);
    expect((await sync(app, a)).status).toBe(429);
    expect((await sync(app, b)).status).toBe(200);
  });

  // The same restart protection applies.
  test('the sync count survives a restart', async () => {
    const user = await createUser();
    await sync(createApp({ syncLimit: 1 }), user);
    expect((await sync(createApp({ syncLimit: 1 }), user)).status).toBe(429);
  });

  // Someone with no account can't use up anyone's allowance: sign-in is checked first.
  test('requests with no sign-in are not counted', async () => {
    const app = createApp({ syncLimit: 1 });
    for (let i = 0; i < 3; i += 1) expect((await request(app).post('/api/sync').send({})).status).toBe(401);
    expect((await pool.query('select count(*)::int as n from rate_limits')).rows[0].n).toBe(0);
  });

  // The default must comfortably cover real use: a large library's first sync, in batches, stays well under it.
  test('the default limit allows a large sync', async () => {
    const user = await createUser();
    const app = createApp();
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).post('/api/sync').set('Authorization', bearer(user.token)).send({ changes: [makeBook()] })).status).toBe(200);
    }
  });
});
