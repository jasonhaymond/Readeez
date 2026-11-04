// test/bookLogic.test.js
// Tests the app's book rules: dates, tidying names, sorting, filtering, search, stats.

const logic = require('../lib/bookLogic');

const book = (fields) => ({ id: 'x', title: 'T', authors: [], categories: [], status: 'finished', rating: null, readDate: null, notes: '', updatedAt: '2026-01-01T00:00:00.000Z', ...fields });

describe('dates', () => {
  // The default read date must be the local day, not UTC, or an evening entry in the US
  // would be dated tomorrow.
  test('localDate uses the local calendar day', () => {
    expect(logic.localDate(new Date(2026, 10, 4, 23, 30))).toBe('2026-11-04');
  });

  // A new book defaults to today, as the brief asks.
  test('a new book is dated today', () => {
    expect(logic.emptyBook().readDate).toBe(logic.localDate());
  });

  // Finishing fills in today, an existing date is kept, and unfinished books have none.
  test('the read date follows the status', () => {
    expect(logic.readDateForStatus('finished', null)).toBe(logic.localDate());
    expect(logic.readDateForStatus('finished', '2020-02-02')).toBe('2020-02-02');
    expect(logic.readDateForStatus('reading', '2020-02-02')).toBeNull();
  });
});

describe('edit times', () => {
  // A slow phone clock must not make a new edit older than the one it replaces, or
  // the server would discard it as stale.
  test('an edit is always later than the previous one', () => {
    const next = logic.nextEditTime('2030-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'));
    expect(next).toBe('2030-01-01T00:00:00.001Z');
  });
});

describe('names', () => {
  // Repeats that differ only by case or spacing become one.
  test('cleanNames removes blanks and repeats', () => {
    expect(logic.cleanNames(['Jo', ' jo ', '', 'Sam'])).toEqual(['Jo', 'Sam']);
  });

  test('distinctNames lists each name once, A to Z', () => {
    const books = [book({ authors: ['Zed', 'amy'] }), book({ authors: ['AMY'] })];
    expect(logic.distinctNames(books, 'authors')).toEqual(['amy', 'Zed']);
  });
});

describe('sorting', () => {
  // The library opens with the most recently read book first.
  test('most recently read comes first', () => {
    const sorted = logic.sortBooks([book({ title: 'Old', readDate: '2020-01-01' }), book({ title: 'New', readDate: '2026-01-01' })]);
    expect(sorted.map((b) => b.title)).toEqual(['New', 'Old']);
  });

  // A book just added goes to the top, even among others read on the same day.
  test('on the same date, the latest edit comes first', () => {
    const sorted = logic.sortBooks([
      book({ title: 'A earlier', readDate: '2026-01-01', updatedAt: '2026-01-01T08:00:00.000Z' }),
      book({ title: 'Z just added', readDate: '2026-01-01', updatedAt: '2026-01-01T09:00:00.000Z' }),
    ]);
    expect(sorted.map((b) => b.title)).toEqual(['Z just added', 'A earlier']);
  });
});

describe('filtering', () => {
  const books = [
    book({ title: 'A', status: 'reading', authors: ['Jo'], categories: ['Sci-fi'], rating: 5 }),
    book({ title: 'B', authors: ['Sam'], categories: ['History'] }),
  ];

  test.each([
    [{ status: 'reading' }, ['A']],
    [{ author: 'jo' }, ['A']],
    [{ category: 'History' }, ['B']],
    [{ rating: 5 }, ['A']],
    [{ rating: 0 }, ['B']],
    [{ status: 'reading', author: 'Sam' }, []],
    [{}, ['A', 'B']],
  ])('%j', (filters, titles) => {
    expect(logic.filterBooks(books, filters).map((b) => b.title)).toEqual(titles);
  });
});

describe('search', () => {
  const books = [
    book({ title: 'Stardust', authors: ['Neil Gaiman'], readDate: '2020-01-01' }),
    book({ title: 'Other', notes: 'reminded me of stardust', categories: ['Fantasy'], readDate: '2026-01-01' }),
  ];

  // Every field is searched, and words can come from different fields.
  test('it finds across fields, in any order', () => {
    expect(logic.searchBooks(books, 'gaiman stardust').map((b) => b.title)).toEqual(['Stardust']);
    expect(logic.searchBooks(books, 'FANTASY').map((b) => b.title)).toEqual(['Other']);
  });

  // A title match is the likeliest target, so it outranks a mention in someone's notes.
  test('title matches come first', () => {
    expect(logic.searchBooks(books, 'stardust').map((b) => b.title)).toEqual(['Stardust', 'Other']);
  });

  test('an empty search finds nothing', () => {
    expect(logic.searchBooks(books, '   ')).toEqual([]);
  });

  // Search text is plain text, not a pattern, so regex characters can't break it.
  test('special characters are harmless', () => {
    expect(logic.searchBooks(books, '.*(')).toEqual([]);
  });
});

describe('stats', () => {
  const books = [
    book({ readDate: '2026-03-01', rating: 5, authors: ['Jo'], categories: ['A'] }),
    book({ readDate: '2026-04-01', rating: 2, authors: ['jo'] }),
    book({ readDate: '2023-01-01', authors: ['Sam'] }),
    book({ status: 'reading', authors: ['Unfinished'] }),
    book({ status: 'want' }),
  ];
  const stats = logic.computeStats(books, 2026);

  test('totals count the right books', () => {
    expect(stats).toMatchObject({ total: 5, finished: 3, reading: 1, want: 1, thisYear: 2 });
    expect(stats.averageRating).toBe(3.5);
  });

  // A gap in reading stays visible, rather than vanishing from the chart.
  test('years with no books still appear', () => {
    expect(stats.byYear.map((y) => [y.label, y.count])).toEqual([['2026', 2], ['2025', 0], ['2024', 0], ['2023', 1]]);
  });

  // Only finished books count, and spellings merge.
  test('rankings count finished books and merge spellings', () => {
    expect(stats.topAuthors).toEqual([{ label: 'Jo', count: 2 }, { label: 'Sam', count: 1 }]);
  });

  test('names past the limit are summed as Other', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => book({ readDate: '2026-01-01', authors: [name] }));
    const { topAuthors } = logic.computeStats(many, 2026);
    expect(topAuthors).toHaveLength(6);
    expect(topAuthors[5]).toEqual({ label: 'Other', count: 2 });
  });

  // An empty library shows nothing, and doesn't divide by zero.
  test('an empty library has no average', () => {
    expect(logic.computeStats([], 2026)).toMatchObject({ total: 0, averageRating: null, byYear: [] });
  });
});
