// test/importBooks.test.js
// Tests reading an export file back in: a hostile or damaged file can't put bad data on the phone, and
// importing an old file can't overwrite later edits.

const { parseExport, planImport } = require('../lib/importBooks');
const { toJson } = require('../server/exportFormat');

const ID = '3f2a9c1e-7b4d-4e8a-9f10-6c2d8e1b5a70';
const OTHER = '3f2a9c1e-7b4d-4e8a-9f10-6c2d8e1b5a71';
const book = (fields = {}) => ({
  id: ID, title: 'T', authors: ['A'], categories: [], status: 'finished', rating: 4, categoryRatings: [], boxTotal: null, boxRead: null, boxTitles: [], readDate: '2026-01-02', notes: 'n',
  updatedAt: '2026-01-02T00:00:00.000Z', ...fields,
});
const file = (books) => JSON.stringify({ app: 'Readeez', books });

describe('reading a file', () => {
  // The whole round trip: what export writes, import can read, unchanged.
  test('an export file reads back unchanged', () => {
    const { books, invalid } = parseExport(toJson([book()], '1.0.0', '2026-01-03T00:00:00.000Z'));
    expect(invalid).toBe(0);
    expect(books[0]).toEqual(book());
  });

  // Damaged or unrelated files give a clear message, not a crash.
  test.each(['not json', '{}', '[]', 'null', '{"app":"Other","books":[]}', '{"app":"Readeez","books":"x"}'])('%s is refused', (text) => {
    expect(() => parseExport(text)).toThrow('Readeez JSON export');
  });

  // A huge file can't freeze the phone.
  test('too many books are refused', () => {
    expect(() => parseExport(file(Array.from({ length: 20001 }, () => book())))).toThrow('too many');
  });

  // Each kind of bad book is left out and counted, while good ones beside it still load.
  test('bad books are left out and counted', () => {
    const bad = [
      null, 'text', [], book({ id: 'nope' }), book({ title: '' }), book({ title: 'x'.repeat(501) }), book({ status: 'stolen' }),
      book({ rating: 6 }), book({ rating: 2.5 }), book({ readDate: '2026-02-31' }), book({ notes: 5 }), book({ updatedAt: 'soon' }),
      book({ authors: 'x' }), book({ authors: [{ a: 1 }] }), book({ categories: Array.from({ length: 21 }, (_, i) => `c${i}`) }),
    ];
    const { books, invalid } = parseExport(file([book(), ...bad]));
    expect(books).toHaveLength(1);
    expect(invalid).toBe(bad.length);
  });

  // Prototype pollution and stray fields: only known fields are copied, so a crafted file can't mark a
  // book as already synced, or alter JavaScript's object behaviour.
  test('unknown fields are dropped', () => {
    const text = `{"app":"Readeez","books":[${JSON.stringify(book()).slice(0, -1)},"dirty":false,"__proto__":{"polluted":true},"evil":1}]}`;
    const { books } = parseExport(text);
    expect(Object.keys(books[0]).sort()).toEqual(Object.keys(book()).sort());
    expect({}.polluted).toBeUndefined();
  });

  // Script text stays inert data. The app draws it as native text, which never runs it.
  test('script text is kept as plain text', () => {
    const { books } = parseExport(file([book({ notes: '<script>alert(1)</script>' })]));
    expect(books[0].notes).toBe('<script>alert(1)</script>');
  });
});

describe('planning an import', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  // A book the phone doesn't have is added, and queued to sync.
  test('a missing book is added', () => {
    const plan = planImport([], [book()], now);
    expect(plan).toMatchObject({ added: 1, updated: 0, skipped: 0 });
    expect(plan.toSave[0]).toMatchObject({ id: ID, dirty: true, deleted: false });
  });

  // The important protection: an old file must not undo later edits.
  test('a book already newer here is skipped', () => {
    const plan = planImport([book({ title: 'Edited later', updatedAt: '2026-05-01T00:00:00.000Z' })], [book()], now);
    expect(plan).toMatchObject({ added: 0, updated: 0, skipped: 1, toSave: [] });
  });

  // Re-importing the same file changes nothing.
  test('an identical book is skipped', () => {
    expect(planImport([book()], [book()], now).skipped).toBe(1);
  });

  test('a newer copy in the file updates the book', () => {
    const plan = planImport([book({ updatedAt: '2025-01-01T00:00:00.000Z' })], [book({ title: 'Newer' })], now);
    expect(plan.updated).toBe(1);
    expect(plan.toSave[0].title).toBe('Newer');
  });

  // Bringing back a deleted book is what importing is for. The new time must beat the deletion's, or
  // it would vanish again at the next sync.
  test('a deleted book comes back and beats the deletion', () => {
    const marker = { id: ID, deleted: true, updatedAt: '2030-01-01T00:00:00.000Z', title: '' };
    const plan = planImport([marker], [book()], now);
    expect(plan.added).toBe(1);
    expect(new Date(plan.toSave[0].updatedAt).getTime()).toBeGreaterThan(new Date(marker.updatedAt).getTime());
  });

  test('saved books get a new edit time so the import wins on other devices', () => {
    expect(planImport([], [book({ id: OTHER })], now).toSave[0].updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('box counts and category ratings in a file', () => {
  const FILE_BOOK = {
    id: '3f2a9c1e-7b4d-4e8a-9f10-6c2d8e1b5a70', title: 'A Box', status: 'reading', categories: ['Crime'], updatedAt: '2026-11-04T00:00:00.000Z',
  };
  const read = (fields) => parseExport(JSON.stringify({ app: 'Readeez', books: [{ ...FILE_BOOK, ...fields }] }));

  test('they are kept', () => {
    const { books } = read({ boxTotal: 7, boxRead: 3, categoryRatings: [{ category: 'Crime', rating: 4 }] });
    expect(books[0]).toMatchObject({ boxTotal: 7, boxRead: 3, categoryRatings: [{ category: 'Crime', rating: 4 }] });
  });

  // A file from v1.0 has neither, and must still import.
  test('an older file without them still imports', () => {
    const { books, invalid } = read({});
    expect(invalid).toBe(0);
    expect(books[0]).toMatchObject({ boxTotal: null, boxRead: null, categoryRatings: [] });
  });

  // A file can be edited, and these counts feed the stats, so impossible values are left out.
  test.each([
    [{ boxTotal: 3, boxRead: 4 }],
    [{ boxRead: 2 }],
    [{ boxTotal: 1 }],
    [{ boxTotal: '7' }],
    [{ categoryRatings: 'lots' }],
  ])('%j is left out', (fields) => {
    expect(read(fields).invalid).toBe(1);
  });

  test('box titles are kept, and older files have none', () => {
    expect(read({ boxTotal: 2, boxTitles: ['One, Two', 'Three'] }).books[0].boxTitles).toEqual(['One, Two', 'Three']);
    expect(read({}).books[0].boxTitles).toEqual([]);
  });

  // A file can be edited, so the same limits as the server apply.
  test.each([[{ boxTitles: ['A'] }], [{ boxTotal: 2, boxTitles: ['A', 'B', 'C'] }], [{ boxTotal: 2, boxTitles: 'A' }], [{ boxTotal: 2, boxTitles: [5] }]])('box titles %j are left out', (fields) => {
    expect(read(fields).invalid).toBe(1);
  });

  // Nothing unexpected from the file reaches a stored book.
  test('a bad rating is dropped, and unknown fields do not get through', () => {
    const { books } = read({ categoryRatings: [{ category: 'Crime', rating: 9 }], isAdmin: true });
    expect(books[0].categoryRatings).toEqual([]);
    expect(books[0].isAdmin).toBeUndefined();
  });
});
