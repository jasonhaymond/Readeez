// test/authorization.test.js
// Security tests for who may do what: anonymous visitors get nothing, regular family
// members can't use admin functions, and no one's data reaches anyone else (IDOR, an
// "insecure direct object reference": reaching someone's record by using its id).

const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { resetDb, createUser, makeBook, bearer } = require('./helpers');

const SOME_ID = '00000000-0000-4000-8000-000000000000';
const PROTECTED_ROUTES = [
  ['get', '/api/auth/me'],
  ['post', '/api/auth/logout'],
  ['post', '/api/auth/password'],
  ['post', '/api/sync'],
  ['get', '/api/nextcloud'],
  ['put', '/api/nextcloud'],
  ['patch', '/api/nextcloud'],
  ['delete', '/api/nextcloud'],
  ['post', '/api/nextcloud/export'],
  ['get', '/api/admin/users'],
  ['post', '/api/admin/invites'],
  ['post', `/api/admin/users/${SOME_ID}/reset-code`],
  ['patch', `/api/admin/users/${SOME_ID}`],
  ['get', '/api/admin/status'],
  ['get', '/api/admin/logs'],
  ['post', '/api/admin/jobs'],
];
const ADMIN_ROUTES = PROTECTED_ROUTES.filter(([, path]) => path.startsWith('/api/admin'));

let app;
beforeEach(async () => {
  await resetDb();
  app = createApp();
});
afterAll(() => pool.end());

// Anonymous access: every protected route refuses a request with no sign-in.
test.each(PROTECTED_ROUTES)('%s %s answers 401 with no token', async (method, path) => {
  const res = await request(app)[method](path);
  expect(res.status).toBe(401);
});

// Forged credentials: a made-up token gets nowhere.
test.each(PROTECTED_ROUTES)('%s %s answers 401 with a made-up token', async (method, path) => {
  const res = await request(app)[method](path).set('Authorization', bearer('made-up-token'));
  expect(res.status).toBe(401);
});

// Privilege escalation: a signed-in regular member can't use any admin route.
test.each(ADMIN_ROUTES)('%s %s answers 403 for a regular member', async (method, path) => {
  const member = await createUser();
  const res = await request(app)[method](path).set('Authorization', bearer(member.token)).send({ disabled: true });
  expect(res.status).toBe(403);
});

describe('admin functions', () => {
  // Normal behaviour: an admin can issue an invite.
  test('an admin can create an invite', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app).post('/api/admin/invites').set('Authorization', bearer(admin.token)).send({});
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });

  // Disabling must take effect at once, including on a phone already signed in.
  test('disabling an account ends its sessions immediately', async () => {
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();
    await request(app).patch(`/api/admin/users/${member.id}`).set('Authorization', bearer(admin.token)).send({ disabled: true });
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(member.token))).status).toBe(401);
  });

  // Lockout: an admin can't disable themselves, which could leave no admins at all.
  test('an admin cannot disable their own account', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app).patch(`/api/admin/users/${admin.id}`).set('Authorization', bearer(admin.token)).send({ disabled: true });
    expect(res.status).toBe(400);
  });

  // Privacy: being an admin shows a book count, never titles or notes, and no route
  // leaks password hashes.
  test('the account list shows no book contents or password hashes', async () => {
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();
    await request(app).post('/api/sync').set('Authorization', bearer(member.token))
      .send({ changes: [makeBook({ title: 'Secret Diary', notes: 'private thoughts' })] });
    const res = await request(app).get('/api/admin/users').set('Authorization', bearer(admin.token));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('Secret Diary');
    expect(text).not.toContain('private thoughts');
    expect(text).not.toContain('$2');
    expect(res.body.users.find((u) => u.id === member.id).bookCount).toBe(1);
  });

  // Malformed input: a bad id gets a clean 400, not a database error.
  test('a malformed account id is refused', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app).post(`/api/admin/users/${encodeURIComponent("1' or '1'='1")}/reset-code`).set('Authorization', bearer(admin.token));
    expect(res.status).toBe(400);
  });
});

describe('isolation between family members', () => {
  // Reading: one person's sync must never return another's books.
  test('a sync returns only your own books', async () => {
    const [a, b] = [await createUser(), await createUser()];
    await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ changes: [makeBook({ title: "A's book" })] });
    const res = await request(app).post('/api/sync').set('Authorization', bearer(b.token)).send({ cursor: '0', changes: [] });
    expect(res.body.changes).toEqual([]);
  });

  // IDOR overwrite: sending another person's book id, even with a much newer time,
  // must leave their book unchanged.
  test('sending someone else\'s book id does not change their book', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const book = makeBook({ title: 'Original' });
    await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ changes: [book] });
    await request(app).post('/api/sync').set('Authorization', bearer(b.token)).send({ changes: [{ ...book, title: 'Hijacked', updatedAt: new Date().toISOString() }] });
    const res = await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ cursor: '0', changes: [] });
    expect(res.body.changes[0].title).toBe('Original');
  });

  // IDOR delete: the same for deletion.
  test('deleting with someone else\'s book id does not delete their book', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const book = makeBook();
    await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ changes: [book] });
    await request(app).post('/api/sync').set('Authorization', bearer(b.token)).send({ changes: [{ id: book.id, deleted: true, updatedAt: new Date().toISOString() }] });
    const res = await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ cursor: '0', changes: [] });
    expect(res.body.changes[0].deleted).toBe(false);
  });

  // Losing-edit path: the code that returns a server copy after a lost conflict must
  // also stay inside your own rows.
  test('a lost conflict returns your own copy, never someone else\'s', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const book = makeBook({ title: "A's title" });
    await request(app).post('/api/sync').set('Authorization', bearer(a.token)).send({ changes: [book] });
    await request(app).post('/api/sync').set('Authorization', bearer(b.token)).send({ changes: [{ ...book, title: "B's title" }] });
    const res = await request(app).post('/api/sync').set('Authorization', bearer(b.token))
      .send({ cursor: '0', changes: [{ ...book, title: 'older', updatedAt: '2020-01-01T00:00:00.000Z' }] });
    expect(res.body.changes.map((c) => c.title)).toEqual(["B's title"]);
  });
});
