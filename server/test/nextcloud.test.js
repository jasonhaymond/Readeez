// test/nextcloud.test.js
// Tests the Nextcloud connection and export: credentials stay write-only, addresses
// that would let someone probe the server's network are refused (SSRF), and exports
// contain only the right person's books. A small local WebDAV stand-in plays Nextcloud,
// since Nextcloud itself is an external service. scripts/ has a real-Nextcloud check.

const http = require('http');
const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { encrypt, decrypt } = require('../secrets');
const nextcloud = require('../nextcloud');
const { resetDb, createUser, makeBook, bearer } = require('./helpers');

const APP_PASSWORD = 'nextcloud-app-password';
let app;
let user;
let dav;
let davUrl;
let files;
let requests;

// A tiny server that answers the WebDAV methods the app uses, keeping "files" in a
// map, and refusing any password except the right one.
beforeAll(async () => {
  dav = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      const expected = `Basic ${Buffer.from(`sam:${APP_PASSWORD}`).toString('base64')}`;
      if (req.headers.authorization !== expected) { res.statusCode = 401; res.end(); return; }
      if (req.method === 'PROPFIND') {
        res.statusCode = 207;
        const hrefs = [...files.keys()].map((p) => `<d:response><d:href>${p}</d:href></d:response>`).join('');
        res.end(`<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
      } else if (req.method === 'MKCOL') {
        res.statusCode = 201;
        res.end();
      } else if (req.method === 'PUT') {
        files.set(req.url, Buffer.concat(chunks).toString('utf8'));
        res.statusCode = 201;
        res.end();
      } else if (req.method === 'DELETE') {
        files.delete(req.url);
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 405;
        res.end();
      }
    });
  });
  await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve));
  davUrl = `http://127.0.0.1:${dav.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => dav.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  app = createApp();
  user = await createUser({ email: 'sam@example.com' });
  files = new Map();
  requests = [];
  // The stand-in runs on this machine, so it has to be an approved private host.
  process.env.NEXTCLOUD_ALLOWED_PRIVATE_HOSTS = '127.0.0.1';
});

const connect = (overrides = {}, who = user) => request(app).put('/api/nextcloud').set('Authorization', bearer(who.token))
  .send({ baseUrl: davUrl, username: 'sam', appPassword: APP_PASSWORD, ...overrides });

describe('credentials', () => {
  // Secrets are write-only: no response may ever contain the app password.
  test('the app password never comes back in any response', async () => {
    const saved = await connect();
    const read = await request(app).get('/api/nextcloud').set('Authorization', bearer(user.token));
    expect(saved.status).toBe(200);
    for (const body of [saved.body, read.body]) {
      expect(JSON.stringify(body)).not.toContain(APP_PASSWORD);
      expect(JSON.stringify(body)).not.toContain('app_password');
    }
    expect(read.body).toMatchObject({ connected: true, username: 'sam' });
  });

  // Database theft: a dump doesn't reveal the password, but the server can still use it.
  test('the app password is encrypted at rest', async () => {
    await connect();
    const { rows } = await pool.query('select app_password_enc from nextcloud_links');
    expect(rows[0].app_password_enc).not.toContain(APP_PASSWORD);
    expect(decrypt(rows[0].app_password_enc)).toBe(APP_PASSWORD);
  });

  // Tampering: altered encrypted data is detected, not decrypted into garbage.
  test('tampered encrypted data is refused', () => {
    const parts = encrypt('secret').split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  // A wrong password is caught when connecting, and nothing is saved.
  test('a wrong password is refused and not saved', async () => {
    const res = await connect({ appPassword: 'wrong' });
    expect(res.status).toBe(400);
    expect((await pool.query('select count(*)::int as n from nextcloud_links')).rows[0].n).toBe(0);
  });

  // Disconnecting really destroys the stored credential.
  test('disconnecting removes the stored password', async () => {
    await connect();
    await request(app).delete('/api/nextcloud').set('Authorization', bearer(user.token));
    expect((await pool.query('select count(*)::int as n from nextcloud_links')).rows[0].n).toBe(0);
  });
});

describe('SSRF protection', () => {
  beforeEach(() => { process.env.NEXTCLOUD_ALLOWED_PRIVATE_HOSTS = ''; });

  // Each address points somewhere a family member must not be able to reach through
  // this server: its own machine, its private network, or cloud metadata. Nothing may
  // be contacted, and no credential may be sent.
  test.each([
    'https://127.0.0.1',
    'https://localhost',
    'https://10.0.0.5',
    'https://192.168.1.1',
    'https://172.16.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:10.0.0.1]',
    'https://[fd00::1]',
  ])('%s is refused', async (baseUrl) => {
    const res = await connect({ baseUrl });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private/i);
    expect(requests).toHaveLength(0);
  });

  // Cleartext: plain http would send the app password unencrypted across the internet.
  test('plain http is refused', async () => {
    const res = await connect({ baseUrl: 'http://cloud.example.com' });
    expect(res.status).toBe(400);
  });

  // Other schemes (file:, ftp:) and junk are refused outright.
  test.each(['file:///etc/passwd', 'ftp://example.com', 'not a url', '', null])('%s is refused', async (baseUrl) => {
    expect((await connect({ baseUrl })).status).toBe(400);
  });

  // Credentials or query strings hidden in the address are refused.
  test.each(['https://user:pass@example.com', 'https://example.com/?x=1'])('%s is refused', async (baseUrl) => {
    expect((await connect({ baseUrl })).status).toBe(400);
  });

  // The check also holds at export time, not just when connecting: a stored address
  // can't be used if the admin later removes its approval.
  test('an export re-checks the address', async () => {
    await pool.query(
      `insert into nextcloud_links (user_id, base_url, username, app_password_enc) values ($1, $2, 'sam', $3)`,
      [user.id, davUrl, encrypt(APP_PASSWORD)]
    );
    const res = await request(app).post('/api/nextcloud/export').set('Authorization', bearer(user.token));
    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  // Redirects aren't followed: a server can't bounce the request to a private address.
  test('a redirect is not followed', async () => {
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    process.env.NEXTCLOUD_ALLOWED_PRIVATE_HOSTS = '127.0.0.1';
    const res = await connect({ baseUrl: `http://127.0.0.1:${redirector.address().port}` });
    await new Promise((resolve) => redirector.close(resolve));
    expect(res.status).toBe(400);
  });

  // Unit check of the address classifier, including IPv4 hidden inside IPv6.
  test('address classification', () => {
    expect(nextcloud.isPrivateAddress('10.9.8.7')).toBe(true);
    expect(nextcloud.isPrivateAddress('::ffff:192.168.0.1')).toBe(true);
    expect(nextcloud.isPrivateAddress('8.8.8.8')).toBe(false);
    expect(nextcloud.isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    // The form a URL parser rewrites ::ffff:10.0.0.1 into.
    expect(nextcloud.isPrivateAddress('::ffff:a00:1')).toBe(true);
    expect(nextcloud.isPrivateAddress('64:ff9b::a00:1')).toBe(true);
    expect(nextcloud.isPrivateAddress('198.18.0.1')).toBe(true);
  });
});

describe('exports', () => {
  const addBooks = (who, books) => request(app).post('/api/sync').set('Authorization', bearer(who.token)).send({ changes: books });
  const exportNow = (who = user) => request(app).post('/api/nextcloud/export').set('Authorization', bearer(who.token));
  const fileEnding = (ending) => [...files.entries()].find(([path]) => path.endsWith(ending))[1];

  // Normal behaviour: both files arrive, and the status records it.
  test('an export writes JSON and CSV files and records success', async () => {
    await connect();
    await addBooks(user, [makeBook({ title: 'My Book' })]);
    const res = await exportNow();
    expect(res.status).toBe(200);
    expect(res.body.lastExportAt).toBeTruthy();
    expect([...files.keys()].every((p) => p.includes('/Readeez/sam-example.com/'))).toBe(true);
    expect(JSON.parse(fileEnding('.json')).books[0].title).toBe('My Book');
    expect(fileEnding('.csv')).toContain('My Book');
  });

  // Privacy: a person's export must never include another family member's books, and
  // deleted books stay out.
  test('an export holds only your own live books', async () => {
    const other = await createUser();
    await connect();
    const gone = makeBook({ title: 'Deleted Book' });
    await addBooks(user, [makeBook({ title: 'Mine' }), gone]);
    await addBooks(user, [{ id: gone.id, deleted: true, updatedAt: '2026-11-05T00:00:00.000Z' }]);
    await addBooks(other, [makeBook({ title: 'Theirs' })]);
    await exportNow();
    const text = fileEnding('.json');
    expect(text).toContain('Mine');
    expect(text).not.toContain('Theirs');
    expect(text).not.toContain('Deleted Book');
  });

  // Retention: old exports are removed, while other files with similar names, and any
  // files the person keeps there, are never touched.
  test('only this app\'s old export files are pruned', async () => {
    await connect();
    const folder = '/remote.php/dav/files/sam/Readeez/sam-example.com';
    const old = `${folder}/readeez-export-20200101.json`;
    const lookalike = `${folder}/readeez-export-20200101-notes.json`;
    const personal = `${folder}/my-reading-plan.txt`;
    [old, lookalike, personal].forEach((p) => files.set(p, 'x'));
    await exportNow();
    expect(files.has(old)).toBe(false);
    expect(files.has(lookalike)).toBe(true);
    expect(files.has(personal)).toBe(true);
  });

  // A failed export is shown to the person, with no internal details.
  test('a failed export records a readable reason', async () => {
    await connect();
    await new Promise((resolve) => dav.close(resolve));
    const res = await exportNow();
    await new Promise((resolve) => dav.listen(Number(new URL(davUrl).port), '127.0.0.1', resolve));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reach/);
    const status = await request(app).get('/api/nextcloud').set('Authorization', bearer(user.token));
    expect(status.body.lastError).toMatch(/reach/);
  });

  // The daily run covers those who are due, skipping those with it turned off.
  test('the daily run exports only people who are due and opted in', async () => {
    await connect();
    await nextcloud.runDueExports();
    expect(files.size).toBe(2);
    files.clear();
    await nextcloud.runDueExports();
    expect(files.size).toBe(0);
    await pool.query(`update nextcloud_links set last_export_at = now() - interval '2 days', daily_export = false`);
    await nextcloud.runDueExports();
    expect(files.size).toBe(0);
  });

  // Exporting with no connection gets a helpful message rather than an error page.
  test('exporting with no connection explains what to do', async () => {
    const res = await exportNow();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect/);
  });
});
