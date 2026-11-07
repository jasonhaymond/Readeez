// test/web.test.js
// Tests for the browser version: signing in with a cookie, forged requests from other websites, shorter sessions, and
// how the built files are served. The files are a small stand-in folder, since only how they're served is being tested.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const pool = require('../db');
const auth = require('../auth');
const { createApp } = require('../app');
const { PASSWORD, resetDb, createUser, makeBook, bearer } = require('./helpers');

const WEB = { 'X-Readeez-Client': 'web', 'Sec-Fetch-Site': 'same-origin' };
let app;
let webRoot;

beforeAll(() => {
  // A throwaway folder arranged like a real build.
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'readeez-web-'));
  fs.mkdirSync(path.join(webRoot, '_expo/static/js'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Readeez</title>');
  fs.writeFileSync(path.join(webRoot, '_expo/static/js/app-abc123.js'), 'console.log(1);');
  fs.writeFileSync(path.join(webRoot, 'favicon.ico'), 'icon');
  fs.writeFileSync(path.join(webRoot, '.secret'), 'hidden');
});
afterAll(async () => {
  fs.rmSync(webRoot, { recursive: true, force: true });
  await pool.end();
});
beforeEach(async () => {
  await resetDb();
  app = createApp({ webRoot });
});

/** Signs in as the web app does. In: the account. Out: the response. */
const webLogin = (user) => request(app).post('/api/auth/login').set(WEB).send({ email: user.email, password: PASSWORD });
/** Takes the "name=value" part out of a response's Set-Cookie header. */
const cookieFrom = (res) => res.headers['set-cookie'][0].split(';')[0];

describe('signing in from a browser', () => {
  // Session theft by an injected script: the token must never be somewhere a page's scripts can read it.
  test('the token arrives only as a cookie scripts can\'t read', async () => {
    const user = await createUser();
    const res = await webLogin(user);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user.email).toBe(user.email);
    const header = res.headers['set-cookie'][0];
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//i);
    // Kept through browser restarts, until the same date the server's session ends.
    expect(header).toMatch(/Max-Age=31536000/i);
  });

  // Theft over an unencrypted connection: in production the cookie is HTTPS-only, and its __Host- prefix makes
  // browsers refuse it unless it's secure and tied to this exact address.
  test('in production the cookie is Secure and uses the __Host- prefix', async () => {
    const user = await createUser();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const header = (await webLogin(user)).headers['set-cookie'][0];
      expect(header.startsWith('__Host-readeez_session=')).toBe(true);
      expect(header).toMatch(/Secure/i);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  // The cookie alone is enough to read this person's own details, which is how a reload stays signed in.
  test('the cookie signs in later requests', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  // Phones are unaffected: they still get a token and no cookie.
  test('a phone still gets a token and no cookie', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.body.token).toBeTruthy();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // Same protection as the phone's sign-in: a wrong password sets nothing.
  test('a wrong password sets no cookie', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/login').set(WEB).send({ email: user.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // A disabled account mustn't be able to sign in from a browser, or keep a browser session.
  test('disabling an account ends its browser session', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    await request(app).patch(`/api/admin/users/${user.id}`).set('Authorization', bearer(admin.token)).send({ disabled: true });
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await webLogin(user)).status).toBe(401);
  });

  // A password change after a suspected break-in must end other browser sessions as well as phones.
  test('changing the password ends browser sessions elsewhere', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const change = await request(app).post('/api/auth/password').set('Authorization', bearer(user.token))
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(change.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  // Signing out has to end the session on the server, as a copied cookie must stop working, and clear it in the browser.
  test('signing out ends the session and clears the cookie', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const res = await request(app).post('/api/auth/logout').set(WEB).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  // The owner's choice for this family: a browser stays signed in for a year of no use, and a phone 90 days. It must
  // still end at a known time, so an abandoned browser doesn't stay signed in forever.
  test('a browser session lasts 365 days, a phone 90', async () => {
    const user = await createUser();
    await webLogin(user);
    const { rows } = await pool.query(
      `select web, round(extract(epoch from expires_at - now()) / 86400) as days from sessions where user_id = $1 order by web`,
      [user.id]
    );
    expect(rows.map((row) => [row.web, Number(row.days)])).toEqual([[false, 90], [true, 365]]);
  });

  // Regular use keeps someone signed in: the renewal moves both the server's date and the browser's, by a year from now.
  test('using a browser session renews both ends for 365 days', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    await pool.query(`update sessions set last_used_at = now() - interval '2 days', expires_at = now() + interval '100 days' where user_id = $1 and web`, [user.id]);
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(res.headers['set-cookie'][0]).toMatch(/Max-Age=31536000/i);
    const { rows } = await pool.query(`select round(extract(epoch from expires_at - now()) / 86400) as days from sessions where user_id = $1 and web`, [user.id]);
    expect(Number(rows[0].days)).toBe(365);
  });

  // A session past its date is over, however long the limit is.
  test('an expired browser session is refused', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    await pool.query(`update sessions set expires_at = now() - interval '1 second' where user_id = $1 and web`, [user.id]);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  // A phone's renewal is unchanged, and must not hand a phone a cookie.
  test('renewing a phone session sets no cookie and stays at 90 days', async () => {
    const user = await createUser();
    await pool.query(`update sessions set last_used_at = now() - interval '2 days' where user_id = $1`, [user.id]);
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(user.token));
    expect(res.headers['set-cookie']).toBeUndefined();
    const { rows } = await pool.query('select round(extract(epoch from expires_at - now()) / 86400) as days from sessions where user_id = $1', [user.id]);
    expect(Number(rows[0].days)).toBe(90);
  });

  // Session fixation or theft through a guess: a made-up cookie is worth nothing.
  test('a made-up cookie is refused', async () => {
    expect((await request(app).get('/api/auth/me').set('Cookie', 'readeez_session=made-up')).status).toBe(401);
  });
});

describe('forged requests from other websites (CSRF)', () => {
  // A hidden form on another site could make a signed-in visitor's browser send this. The browser would add the
  // cookie by itself if sameSite ever failed, so the server refuses anything that isn't from its own page.
  test.each([
    ['no marker', {}],
    ['a marker from another site', { 'X-Readeez-Client': 'web', 'Sec-Fetch-Site': 'cross-site' }],
    ['a marker from a sibling address', { 'X-Readeez-Client': 'web', 'Sec-Fetch-Site': 'same-site' }],
  ])('a book change with %s is refused', async (_name, headers) => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const res = await request(app).post('/api/sync').set('Cookie', cookie).set(headers).send({ changes: [makeBook({ title: 'Forged' })] });
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`select 1 from books where title = 'Forged'`);
    expect(rows).toEqual([]);
  });

  // Password change is the worst thing to forge, and admin actions next.
  test('forged password changes and admin actions are refused', async () => {
    const admin = await createUser({ role: 'admin' });
    const cookie = cookieFrom(await webLogin(admin));
    const forged = (req) => req.set('Cookie', cookie).set('Sec-Fetch-Site', 'cross-site');
    expect((await forged(request(app).post('/api/auth/password')).send({ currentPassword: PASSWORD, newPassword: 'attacker-password' })).status).toBe(403);
    expect((await forged(request(app).post('/api/admin/invites')).send({ role: 'admin' })).status).toBe(403);
  });

  // Login CSRF: another site signing the visitor in to the attacker's account, then collecting what they add.
  test('a forged sign-in is refused', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/login')
      .set({ 'X-Readeez-Client': 'web', 'Sec-Fetch-Site': 'cross-site' })
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  // The real web app's request goes through.
  test('a request from its own page works', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const res = await request(app).post('/api/sync').set('Cookie', cookie).set(WEB).send({ changes: [makeBook()] });
    expect(res.status).toBe(200);
  });

  // Phones send a Bearer token, which browsers never add by themselves, so they don't need the marker.
  test('a phone needs no marker', async () => {
    const user = await createUser();
    expect((await request(app).post('/api/sync').set('Authorization', bearer(user.token)).send({ changes: [] })).status).toBe(200);
  });

  // Reading another site's answer needs permission through CORS, which isn't given, and cookies are never allowed.
  test('no other website is allowed to read answers with cookies', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'https://attacker.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('role checks through a browser session', () => {
  // The admin rules are the same whichever way someone signed in.
  test('a member\'s browser session can\'t reach admin routes, and an admin\'s can', async () => {
    const member = await createUser();
    const admin = await createUser({ role: 'admin' });
    const memberCookie = cookieFrom(await webLogin(member));
    const adminCookie = cookieFrom(await webLogin(admin));
    expect((await request(app).get('/api/admin/users').set('Cookie', memberCookie)).status).toBe(403);
    expect((await request(app).post('/api/admin/invites').set(WEB).set('Cookie', memberCookie).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).get('/api/admin/users').set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).post('/api/admin/invites').set(WEB).set('Cookie', adminCookie).send({ role: 'member' })).status).toBe(201);
  });
});

describe('serving the web app', () => {
  test('the page loads with a policy allowing only this site', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Readeez');
    const policy = res.headers['content-security-policy'];
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  // An update must reach people at once, so the page itself is never kept.
  test('the page is never cached, but fingerprinted files are', async () => {
    expect((await request(app).get('/')).headers['cache-control']).toBe('no-store');
    const script = await request(app).get('/_expo/static/js/app-abc123.js');
    expect(script.status).toBe(200);
    expect(script.headers['cache-control']).toContain('immutable');
    expect((await request(app).get('/favicon.ico')).headers['cache-control']).toBe('no-store');
  });

  // Any page address loads the app, so a reload never shows a 404.
  test('other page addresses load the app', async () => {
    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Readeez');
  });

  // Path traversal: nothing outside the built folder can be read through a crafted address.
  test.each(['/../package.json', '/..%2f..%2fpackage.json', '/_expo/../../index.js', '/%2e%2e/%2e%2e/etc/passwd'])('%s reveals nothing outside', async (address) => {
    const res = await request(app).get(address);
    expect(res.text).not.toContain('"dependencies"');
    expect(res.text).not.toContain('root:');
    expect(res.text).not.toContain('require(');
  });

  // Hidden files don't get served, even from inside the folder.
  test('dotfiles are refused', async () => {
    const res = await request(app).get('/.secret');
    expect(res.text).not.toContain('hidden');
  });

  // An API address never falls through to the page, where a mistake could look like a success.
  test('unknown API addresses stay a JSON 404 under the API\'s own policy', async () => {
    for (const address of ['/api/no-such-route', '/api']) {
      const res = await request(app).get(address);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found.');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    }
  });

  test('the API keeps its strict policy when the web app is present', async () => {
    expect((await request(app).get('/api/health')).headers['content-security-policy']).toContain("default-src 'none'");
  });

  // A server that lost its web files should say so at startup rather than quietly serving nothing.
  test('a folder with no built app stops the server starting', () => {
    expect(() => createApp({ webRoot: path.join(webRoot, 'missing') })).toThrow(/WEB_ROOT/);
  });

  // Without a web folder, only the API runs, and the behaviour stays as it was.
  test('with no web folder, every address is a JSON 404', async () => {
    const res = await request(createApp({ webRoot: '' })).get('/');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found.');
  });
});

describe('session token storage', () => {
  // A database backup mustn't let its reader act as a family member through a browser either.
  test('browser session tokens are stored only as hashes', async () => {
    const user = await createUser();
    const cookie = cookieFrom(await webLogin(user));
    const token = cookie.split('=')[1];
    const { rows } = await pool.query('select token_hash from sessions where web and user_id = $1', [user.id]);
    expect(rows[0].token_hash).not.toBe(token);
    expect(auth.webCookieName()).toBe('readeez_session');
  });
});
