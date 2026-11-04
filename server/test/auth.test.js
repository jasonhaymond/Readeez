// test/auth.test.js
// Security tests for authentication: sign-in, brute-force limits, password storage,
// sessions, invite codes and reset codes. All go through real HTTP requests against
// the real app and a real database.

const request = require('supertest');
const pool = require('../db');
const auth = require('../auth');
const { createApp } = require('../app');
const { PASSWORD, resetDb, createUser, bearer } = require('./helpers');

let app;
beforeEach(async () => {
  await resetDb();
  app = createApp();
});
afterAll(() => pool.end());

describe('signing in', () => {
  // Normal behaviour: the right password gets a working session token.
  test('correct password signs in and the token works', async () => {
    const user = await createUser({ email: 'sam@example.com' });
    const res = await request(app).post('/api/auth/login').send({ email: 'SAM@example.com ', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(res.body.token));
    expect(me.status).toBe(200);
  });

  // User enumeration: an attacker mustn't learn which emails have accounts from the
  // wording of the error.
  test('unknown email and wrong password give identical answers', async () => {
    await createUser({ email: 'sam@example.com' });
    const wrong = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: 'wrong-password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  // Brute force: after 10 failures, even the correct password is turned away, so
  // passwords can't be guessed at speed.
  test('sign-in is blocked after 10 failures', async () => {
    await createUser({ email: 'sam@example.com' });
    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: `wrong-${i}` });
    }
    const res = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    expect(res.status).toBe(429);
  });

  // Type confusion: sending an object as the password must not reach the comparison.
  test('non-text credentials are refused', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: { $ne: '' }, password: { $ne: '' } });
    expect(res.status).toBe(400);
  });

  // A disabled family member can't get back in, and can't tell that's the reason.
  test('a disabled account cannot sign in', async () => {
    const user = await createUser({ email: 'sam@example.com' });
    await pool.query('update users set disabled_at = now() where id = $1', [user.id]);
    const res = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('password storage', () => {
  // Database theft: stored passwords must be bcrypt hashes, never the password.
  test('passwords are stored only as bcrypt hashes', async () => {
    const user = await createUser();
    const { rows } = await pool.query('select password_hash from users where id = $1', [user.id]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  // bcrypt ignores anything past 72 bytes, so longer passwords must be refused
  // rather than silently shortened.
  test('short and over-long passwords are refused', () => {
    expect(auth.passwordProblem('short')).toBeTruthy();
    expect(auth.passwordProblem('x'.repeat(73))).toBeTruthy();
    expect(auth.passwordProblem(PASSWORD)).toBeNull();
  });
});

describe('sessions', () => {
  // Database theft: a token read from a backup must not be usable.
  test('session tokens are stored only as hashes', async () => {
    const user = await createUser();
    const { rows } = await pool.query('select token_hash from sessions where user_id = $1', [user.id]);
    expect(rows[0].token_hash).not.toBe(user.token);
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(rows[0].token_hash));
    expect(res.status).toBe(401);
  });

  // Signing out must kill the token on the server, not just forget it on the phone.
  test('logout invalidates the token', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/logout').set('Authorization', bearer(user.token));
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(user.token));
    expect(res.status).toBe(401);
  });

  // A lost phone's old session must eventually stop working.
  test('an expired session is refused', async () => {
    const user = await createUser();
    await pool.query(`update sessions set expires_at = now() - interval '1 second' where user_id = $1`, [user.id]);
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(user.token));
    expect(res.status).toBe(401);
  });

  // Changing a password after a suspected compromise must sign out the other devices.
  test('changing password signs out other devices but keeps this one', async () => {
    const user = await createUser();
    const other = await auth.createSession(user.id);
    const res = await request(app).post('/api/auth/password').set('Authorization', bearer(user.token))
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(other))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(user.token))).status).toBe(200);
  });

  // Someone holding an unlocked phone can't change the password without knowing it.
  test('changing password requires the current password', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/password').set('Authorization', bearer(user.token))
      .send({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);
  });
});

describe('invite codes', () => {
  const details = { email: 'new@example.com', displayName: 'New Person', password: PASSWORD };

  // Normal behaviour, including that the invite decides the role.
  test('an invite creates an account with the invited role', async () => {
    const code = await auth.createInvite('member', null);
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
  });

  // Privilege escalation: asking for admin in the request must have no effect.
  test('a member invite cannot be used to become an admin', async () => {
    const code = await auth.createInvite('member', null);
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code, role: 'admin' });
    expect(res.body.user.role).toBe('member');
  });

  // No open registration: without a real code, no account can be created.
  test('an invented code creates nothing', async () => {
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code: 'AAAA-BBBB-CCCC-DDDD' });
    expect(res.status).toBe(400);
    expect((await pool.query('select count(*)::int as n from users')).rows[0].n).toBe(0);
  });

  // Single use: a code passed around can only ever create one account.
  test('a code works only once', async () => {
    const code = await auth.createInvite('member', null);
    await request(app).post('/api/auth/redeem').send({ ...details, code });
    const res = await request(app).post('/api/auth/redeem').send({ ...details, email: 'second@example.com', code });
    expect(res.status).toBe(400);
  });

  // Race: two simultaneous requests with one code must not create two accounts.
  test('a code cannot be redeemed twice at the same moment', async () => {
    const code = await auth.createInvite('member', null);
    const results = await Promise.all(['a', 'b', 'c'].map((who) => request(app).post('/api/auth/redeem')
      .send({ ...details, email: `${who}@example.com`, code })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  // An old code found in a message thread must be useless.
  test('an expired code is refused', async () => {
    const code = await auth.createInvite('member', null);
    await pool.query(`update access_codes set expires_at = now() - interval '1 second'`);
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code });
    expect(res.status).toBe(400);
  });

  // Account takeover: an invite must not replace an existing account's password, and
  // the failed attempt must not burn the code.
  test('an invite cannot take over an existing email', async () => {
    await createUser({ email: 'new@example.com' });
    const code = await auth.createInvite('admin', null);
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code });
    expect(res.status).toBe(409);
    const login = await request(app).post('/api/auth/login').send({ email: 'new@example.com', password: PASSWORD });
    expect(login.body.user.role).toBe('member');
    const { rows } = await pool.query('select used_at from access_codes');
    expect(rows[0].used_at).toBeNull();
  });

  // Database theft: a stored code can't be read back and used.
  test('codes are stored only as hashes', async () => {
    const code = await auth.createInvite('member', null);
    const { rows } = await pool.query('select code_hash from access_codes');
    expect(rows[0].code_hash).not.toContain(code.replace(/-/g, ''));
  });

  // Brute force: guessing codes is limited like guessing passwords.
  test('code guessing is rate limited', async () => {
    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/auth/redeem').send({ ...details, code: `WRONG-${i}` });
    }
    const res = await request(app).post('/api/auth/redeem').send({ ...details, code: 'WRONG-X' });
    expect(res.status).toBe(429);
  });
});

describe('reset codes', () => {
  // A reset changes the password and signs out every device, including an attacker's.
  test('a reset changes the password and ends all sessions', async () => {
    const user = await createUser({ email: 'sam@example.com' });
    const code = await auth.createResetCode(user.id, null);
    const res = await request(app).post('/api/auth/reset').send({ code, password: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', bearer(user.token))).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: 'a-brand-new-password' });
    expect(login.status).toBe(200);
  });

  // Single use: a reset code found later can't take the account over again.
  test('a reset code works only once', async () => {
    const user = await createUser();
    const code = await auth.createResetCode(user.id, null);
    await request(app).post('/api/auth/reset').send({ code, password: 'a-brand-new-password' });
    const res = await request(app).post('/api/auth/reset').send({ code, password: 'attacker-password-1' });
    expect(res.status).toBe(400);
  });

  // An expired reset code is useless.
  test('an expired reset code is refused', async () => {
    const user = await createUser();
    const code = await auth.createResetCode(user.id, null);
    await pool.query(`update access_codes set expires_at = now() - interval '1 second'`);
    const res = await request(app).post('/api/auth/reset').send({ code, password: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });

  // Issuing a new code must cancel the old one, in case that's the one that leaked.
  test('a new reset code cancels the previous one', async () => {
    const user = await createUser();
    const first = await auth.createResetCode(user.id, null);
    await auth.createResetCode(user.id, null);
    const res = await request(app).post('/api/auth/reset').send({ code: first, password: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });

  // Confusion attack: an invite code must not work as a reset code, or the reverse.
  test('an invite code cannot be used as a reset code', async () => {
    const code = await auth.createInvite('member', null);
    const res = await request(app).post('/api/auth/reset').send({ code, password: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });
});
