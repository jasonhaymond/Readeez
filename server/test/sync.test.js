// test/sync.test.js
// Behaviour and input-handling tests for POST /api/sync: last-edit-wins, deletions,
// cursors, and what hostile or malformed books do (injection, oversized data).

const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { recordAppVersion } = require('../appMeta');
const { resetDb, createUser, makeBook, bearer } = require('./helpers');

let app;
let user;
const sync = (body, who = user) => request(app).post('/api/sync').set('Authorization', bearer(who.token)).send(body);

beforeEach(async () => {
  await resetDb();
  app = createApp();
  user = await createUser();
});
afterAll(() => pool.end());

describe('moving books between devices', () => {
  // The core promise: a book added on one phone appears on another.
  test('a book pushed by one device reaches another', async () => {
    const book = makeBook({ authors: ['One', 'Two'], categories: ['A', 'B'] });
    await sync({ changes: [book] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0]).toMatchObject({ id: book.id, title: book.title, authors: ['One', 'Two'], categories: ['A', 'B'], readDate: '2026-11-04' });
  });

  // Efficiency: once caught up, a sync returns nothing new.
  test('a sync from the latest cursor returns nothing', async () => {
    const first = await sync({ changes: [makeBook()] });
    const second = await sync({ cursor: first.body.cursor });
    expect(second.body.changes).toEqual([]);
    expect(second.body.cursor).toBe(first.body.cursor);
  });

  // Large libraries come down in pages, without skipping or repeating any book.
  test('more than one page is delivered completely', async () => {
    for (let batch = 0; batch < 3; batch += 1) {
      await sync({ changes: Array.from({ length: 400 }, () => makeBook()) });
    }
    const seen = new Set();
    let cursor = '0';
    let more = true;
    let pages = 0;
    while (more) {
      const res = await sync({ cursor });
      res.body.changes.forEach((c) => seen.add(c.id));
      ({ cursor, more } = res.body);
      pages += 1;
    }
    expect(seen.size).toBe(1200);
    expect(pages).toBe(2);
  });
});

describe('last edit wins', () => {
  // The newer edit replaces the older one, whichever order they arrive in.
  test('a newer edit wins', async () => {
    const book = makeBook();
    await sync({ changes: [book] });
    await sync({ changes: [{ ...book, title: 'Newer', updatedAt: '2026-11-05T00:00:00.000Z' }] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0].title).toBe('Newer');
  });

  // An older edit from a phone that was offline loses, and the server's copy comes
  // back, even though the phone's cursor is already past it.
  test('an older edit loses and the phone is sent the winner', async () => {
    const book = makeBook({ title: 'Winner' });
    const first = await sync({ changes: [book] });
    const res = await sync({ cursor: first.body.cursor, changes: [{ ...book, title: 'Stale', updatedAt: '2020-01-01T00:00:00.000Z' }] });
    expect(res.body.changes).toHaveLength(1);
    expect(res.body.changes[0].title).toBe('Winner');
  });

  // Retried requests: sending the same change twice has no extra effect, so a dropped
  // connection can't double anything.
  test('resending the same change changes nothing', async () => {
    const book = makeBook();
    const first = await sync({ changes: [book] });
    await sync({ changes: [book] });
    const { rows } = await pool.query('select count(*)::int as n, max(seq) as seq from books');
    expect(rows[0].n).toBe(1);
    expect(rows[0].seq).toBe(first.body.cursor);
  });

  // Clock tampering: a phone with its clock far ahead must not beat all later edits.
  test('an edit dated in the future is treated as happening now', async () => {
    const book = makeBook({ updatedAt: '2099-01-01T00:00:00.000Z' });
    await sync({ changes: [book] });
    const { rows } = await pool.query('select updated_at from books');
    expect(rows[0].updated_at.getTime()).toBeLessThanOrEqual(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sync({ changes: [{ ...book, title: 'Honest edit', updatedAt: new Date().toISOString() }] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0].title).toBe('Honest edit');
  });
});

describe('deleting', () => {
  // A delete reaches other devices, and the contents really leave the server.
  test('a deleted book reaches other devices with its contents erased', async () => {
    const book = makeBook({ notes: 'private' });
    await sync({ changes: [book] });
    await sync({ changes: [{ id: book.id, deleted: true, updatedAt: '2026-11-05T00:00:00.000Z' }] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0]).toMatchObject({ id: book.id, deleted: true, title: '', notes: '' });
    const { rows } = await pool.query('select notes, title from books');
    expect(rows[0]).toEqual({ notes: '', title: '' });
  });

  // An offline phone's older edit must not bring back a book deleted since.
  test('an older edit does not bring back a deleted book', async () => {
    const book = makeBook();
    await sync({ changes: [book] });
    await sync({ changes: [{ id: book.id, deleted: true, updatedAt: '2026-11-05T00:00:00.000Z' }] });
    await sync({ changes: [{ ...book, title: 'Back from the dead', updatedAt: '2026-11-04T18:00:00.000Z' }] });
    const { rows } = await pool.query('select deleted from books');
    expect(rows[0].deleted).toBe(true);
  });
});

describe('restored server', () => {
  // The reliable signal: a restore sets a new epoch, so a phone notices even when other phones have
  // pushed the numbering past its position first.
  test('a changed epoch triggers a reset, even with a valid position', async () => {
    await recordAppVersion();
    const book = makeBook();
    const first = await sync({ changes: [book] });
    expect(first.body.reset).toBe(false);
    const same = await sync({ cursor: first.body.cursor, epoch: first.body.epoch });
    expect(same.body).toMatchObject({ reset: false, changes: [] });
    await pool.query('update app_meta set sync_epoch = gen_random_uuid()');
    const after = await sync({ cursor: first.body.cursor, epoch: first.body.epoch });
    expect(after.body.reset).toBe(true);
    expect(after.body.changes.map((c) => c.id)).toEqual([book.id]);
    expect(after.body.epoch).not.toBe(first.body.epoch);
  });

  // A phone's very first sync has no epoch to compare, and isn't treated as a restore.
  test('a first sync is not a reset', async () => {
    await recordAppVersion();
    expect((await sync({ cursor: '0' })).body.reset).toBe(false);
  });

  // Injection through the new field is refused.
  test('a malformed epoch is refused', async () => {
    expect((await sync({ epoch: "x' or 1=1" })).status).toBe(400);
  });

  // After a restore from backup, a phone's position is ahead of the database. It must
  // be told, or it would silently miss new changes forever.
  test('a cursor ahead of the database triggers a reset and a full resend', async () => {
    const book = makeBook();
    await sync({ changes: [book] });
    const res = await sync({ cursor: '999999999' });
    expect(res.body.reset).toBe(true);
    expect(res.body.changes.map((c) => c.id)).toEqual([book.id]);
  });
});

describe('hostile and malformed input', () => {
  // SQL injection: hostile text in every text field is stored as harmless data, and
  // the table survives.
  test('SQL injection text is stored as plain text', async () => {
    const attack = "'); drop table books; --";
    const book = makeBook({ title: attack, authors: [attack], categories: [attack], notes: attack });
    await sync({ changes: [book] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0]).toMatchObject({ title: attack, authors: [attack], notes: attack });
    expect((await pool.query('select count(*)::int as n from books')).rows[0].n).toBe(1);
  });

  // SQL injection through the cursor, which reaches a query.
  test('an injected cursor is refused', async () => {
    expect((await sync({ cursor: '0 or 1=1' })).status).toBe(400);
    expect((await sync({ cursor: { a: 1 } })).status).toBe(400);
  });

  // Stored XSS: script text comes back unchanged as JSON data. The app renders it as
  // plain text in native views, which never run it, and this API serves no HTML.
  test('script text is returned as JSON data, not HTML', async () => {
    const attack = '<script>alert(1)</script>';
    await sync({ changes: [makeBook({ notes: attack })] });
    const res = await sync({ cursor: '0' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.changes[0].notes).toBe(attack);
  });

  // One bad book is reported, and the good one beside it still saves.
  test('invalid books are rejected individually', async () => {
    const good = makeBook();
    const bad = [
      makeBook({ title: '' }),
      makeBook({ title: 'x'.repeat(501) }),
      makeBook({ id: 'not-a-uuid' }),
      makeBook({ status: 'stolen' }),
      makeBook({ rating: 6 }),
      makeBook({ rating: 0 }),
      makeBook({ rating: 2.5 }),
      makeBook({ readDate: '2026-02-31' }),
      makeBook({ readDate: "2026-01-01'; --" }),
      makeBook({ notes: 'x'.repeat(20001) }),
      makeBook({ authors: 'not a list' }),
      makeBook({ authors: Array.from({ length: 21 }, (_, i) => `A${i}`) }),
      makeBook({ categories: [{ a: 1 }] }),
      makeBook({ updatedAt: 'yesterday' }),
      null,
    ];
    const res = await sync({ changes: [good, ...bad] });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(bad.length);
    expect((await pool.query('select id from books')).rows.map((r) => r.id)).toEqual([good.id]);
  });

  // Optional fields really are optional: no rating, date or author is fine.
  test('a minimal book is accepted', async () => {
    const res = await sync({ changes: [makeBook({ rating: null, readDate: null, authors: [], categories: [], notes: '' })] });
    expect(res.body.rejected).toEqual([]);
  });

  // Duplicates differing only by case are merged, so filters don't show them twice.
  test('repeated names are merged', async () => {
    await sync({ changes: [makeBook({ authors: ['Jo', ' jo ', 'JO', 'Sam'] })] });
    const res = await sync({ cursor: '0' });
    expect(res.body.changes[0].authors).toEqual(['Jo', 'Sam']);
  });

  // Denial of service: too many changes in one request are refused.
  test('too many changes are refused', async () => {
    expect((await sync({ changes: Array.from({ length: 501 }, () => makeBook()) })).status).toBe(400);
  });

  // Denial of service: an oversized body is refused before it's fully processed.
  test('an oversized request is refused', async () => {
    const res = await sync({ changes: [makeBook({ notes: 'x'.repeat(13 * 1024 * 1024) })] });
    expect(res.status).toBe(413);
  });

  // Denial of service: the sign-in check runs before the body is read, so without an account nobody
  // can make the server parse a large request. Bad JSON getting 401 instead of 400 proves that order.
  test('a request with no sign-in is refused before its body is parsed', async () => {
    const res = await request(app).post('/api/sync').set('Content-Type', 'application/json').send('{"cursor":');
    expect(res.status).toBe(401);
  });

  // Malformed JSON gets a clean client error with no internal details.
  test('malformed JSON gets a clean 400', async () => {
    const res = await request(app).post('/api/sync').set('Authorization', bearer(user.token))
      .set('Content-Type', 'application/json').send('{"cursor":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|SyntaxError|Unexpected|\.js:\d+/);
  });
});
