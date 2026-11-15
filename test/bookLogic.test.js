// test/bookLogic.test.js
// Tests the app's book rules: dates, tidying names, sorting, filtering, search, stats.

const logic = require('../lib/bookLogic');

const book = (fields) => ({ id: 'x', title: 'T', authors: [], categories: [], status: 'finished', rating: null, readDate: null, notes: '', updatedAt: '2026-01-01T00:00:00.000Z', ...fields });

describe('books saved while the library loads', () => {
  // Data loss: a book saved before loading finishes wasn't in what was read, and must not vanish or miss the next sync.
  test('a new book survives the load finishing', () => {
    const merged = logic.mergeLoadedBooks([book({ id: 'old' })], [book({ id: 'new', dirty: true })]);
    expect(merged.map((b) => b.id).sort()).toEqual(['new', 'old']);
    expect(merged.find((b) => b.id === 'new').dirty).toBe(true);
  });

  // An edit made during loading is newer than the stored copy, so the older copy mustn't overwrite it.
  test('an edit replaces the copy that was read', () => {
    const merged = logic.mergeLoadedBooks([book({ id: 'a', title: 'Stored' })], [book({ id: 'a', title: 'Edited' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Edited');
  });
});

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

describe('book boxes', () => {
  const { parseBox, readCount, readDateForStatus: dateFor } = require('../lib/bookLogic');

  // Stats count what was read from a box, whatever its status, and nothing for a box not started.
  test('a box counts the books read from it', () => {
    expect(readCount({ boxTotal: 7, boxRead: 3, status: 'reading' })).toBe(3);
    expect(readCount({ boxTotal: 7, boxRead: 3, status: 'finished' })).toBe(3);
    expect(readCount({ boxTotal: 7, boxRead: 0, status: 'want' })).toBe(0);
    expect(readCount({ status: 'finished' })).toBe(1);
    expect(readCount({ status: 'reading' })).toBe(0);
  });

  test('the stats add box counts into every total', () => {
    const books = [
      { status: 'finished', readDate: '2026-01-01', authors: ['A'], categories: ['X'] },
      { status: 'reading', boxTotal: 7, boxRead: 3, readDate: '2026-02-01', authors: ['A'], categories: ['X'], rating: 4 },
      { status: 'want', boxTotal: 5, boxRead: 0, authors: ['B'], categories: ['Y'] },
    ];
    const stats = logic.computeStats(books, 2026);
    expect(stats.finished).toBe(4);
    expect(stats.thisYear).toBe(4);
    expect(stats.byYear).toEqual([{ label: '2026', count: 4 }]);
    expect(stats.topAuthors).toEqual([{ label: 'A', count: 4 }]);
    expect(stats.topCategories).toEqual([{ label: 'X', count: 4 }]);
    expect(stats.reading).toBe(1);
    expect(stats.want).toBe(1);
    expect(stats.averageRating).toBe(4);
  });

  // A box being read needs a date for what's been read so far to count under.
  test('a box with books read keeps a date, even before it\'s finished', () => {
    expect(dateFor('reading', '2026-01-01', 2)).toBe('2026-01-01');
    expect(dateFor('reading', '2026-01-01', 0)).toBeNull();
    expect(dateFor('reading', null, 2)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test.each([
    ['', '', { boxTotal: null, boxRead: null }],
    ['7', '', { boxTotal: 7, boxRead: 0 }],
    ['7', '3', { boxTotal: 7, boxRead: 3 }],
    [' 7 ', ' 7 ', { boxTotal: 7, boxRead: 7 }],
  ])('box fields %j and %j are read correctly', (total, read, expected) => {
    expect(parseBox(total, read)).toEqual(expected);
  });

  // New books start as finished, so a finished box left blank mustn't count as none read.
  test('a finished box with the read count left blank counts them all, and a typed 0 stays 0', () => {
    expect(parseBox('7', '', 'finished')).toEqual({ boxTotal: 7, boxRead: 7 });
    expect(parseBox('7', '0', 'finished')).toEqual({ boxTotal: 7, boxRead: 0 });
    expect(parseBox('7', '', 'reading')).toEqual({ boxTotal: 7, boxRead: 0 });
    expect(parseBox('', '', 'finished')).toEqual({ boxTotal: null, boxRead: null });
  });

  test.each([['', '3'], ['1', ''], ['1001', ''], ['2.5', ''], ['abc', ''], ['7', '8'], ['7', '-1'], ['7', 'x']])('box fields %j and %j are a typing mistake', (total, read) => {
    expect(parseBox(total, read).error).toBeTruthy();
  });
});

describe('titles in a book box', () => {
  const { boxTitlesProblem, searchBooks: search } = require('../lib/bookLogic');

  test('more titles than the box holds is a mistake to point out', () => {
    expect(boxTitlesProblem(['A', 'B', 'C'], 2)).toMatch(/3 titles.*2 books/);
    expect(boxTitlesProblem(['A', 'B'], 2)).toBeNull();
    expect(boxTitlesProblem(['A'], null)).toBeNull();
  });

  test('search finds a book by a title inside its box', () => {
    const box = { title: 'Box Set', authors: [], categories: [], boxTitles: ['The Hidden One'], updatedAt: '2026-01-01' };
    expect(search([box], 'hidden')).toEqual([box]);
  });
});

describe('category ratings', () => {
  const { categoryAverages, cleanCategoryRatings, emptyBook: blank, setCategoryRating } = require('../lib/bookLogic');

  test('a new book has none, and is not a box', () => {
    expect(blank()).toMatchObject({ categoryRatings: [], boxTotal: null, boxRead: null });
  });

  // Removing a category takes its stars with it, and spelling follows the book.
  test('only valid stars for the book\'s own categories are kept', () => {
    const cleaned = cleanCategoryRatings(
      [{ category: 'fantasy', rating: 5 }, { category: 'Fantasy', rating: 1 }, { category: 'Gone', rating: 3 }, { category: 'Crime', rating: 6 }, null],
      ['Fantasy', 'Crime']
    );
    expect(cleaned).toEqual([{ category: 'Fantasy', rating: 5 }]);
  });

  // Prototype pollution: an odd category name is only text.
  test('a category called __proto__ is only text', () => {
    expect(cleanCategoryRatings([{ category: '__proto__', rating: 2 }], ['__proto__'])).toEqual([{ category: '__proto__', rating: 2 }]);
  });

  test('stars can be set, replaced and cleared', () => {
    let ratings = setCategoryRating([], 'Crime', 3);
    ratings = setCategoryRating(ratings, 'crime', 5);
    expect(ratings).toEqual([{ category: 'crime', rating: 5 }]);
    expect(setCategoryRating(ratings, 'Crime', null)).toEqual([]);
  });

  test('averages are per category, highest first, ignoring case', () => {
    const books = [
      { categoryRatings: [{ category: 'Crime', rating: 2 }, { category: 'Fantasy', rating: 5 }] },
      { categoryRatings: [{ category: 'crime', rating: 3 }] },
      {},
    ];
    expect(categoryAverages(books)).toEqual([
      { label: 'Fantasy', count: 5, ratings: 1 },
      { label: 'Crime', count: 2.5, ratings: 2 },
    ]);
  });
});

describe('series', () => {
  const { distinctSeries, filterBooks, searchBooks: search } = require('../lib/bookLogic');
  const shelf = [
    book({ title: 'Mort', series: 'Discworld' }),
    book({ title: 'Guards', series: 'discworld' }),
    book({ title: 'Dune', series: 'Dune Chronicles' }),
    book({ title: 'Standalone' }),
  ];

  // Spellings that differ only in case are one series, so the filter doesn't list it twice.
  test('series names are listed once, A to Z', () => {
    expect(distinctSeries(shelf)).toEqual(['Discworld', 'Dune Chronicles']);
  });

  test('the series filter ignores case', () => {
    expect(filterBooks(shelf, { series: 'DISCWORLD' }).map((b) => b.title)).toEqual(['Mort', 'Guards']);
  });

  test('search finds a book by its series', () => {
    expect(search(shelf, 'chronicles').map((b) => b.title)).toEqual(['Dune']);
  });

  test('a new book starts with no series', () => {
    expect(logic.emptyBook().series).toBe('');
  });
});

describe('year counts (books read before Readeez)', () => {
  const { computeStats, parseTally, readCount, tallyId, yearCounts, readYears } = require('../lib/bookLogic');
  const tally = (year, count, fields = {}) => ({ id: tallyId(year), kind: 'tally', tallyCount: count, status: 'finished', readDate: `${year}-01-01`, authors: [], categories: [], ...fields });

  // The fixed id is what keeps each year to one count across devices; it must match the server's.
  test('each year has one fixed id, the same as the server uses', () => {
    expect(tallyId(2023)).toBe('00000000-0000-4000-8000-000000002023');
    expect(require('../server/bookValidation').tallyId(2023)).toBe(tallyId(2023));
  });

  test('a year count counts as its number', () => {
    expect(readCount(tally(2023, 40))).toBe(40);
  });

  // Typing mistakes are pointed out, not guessed at, and the limits match the server's.
  test.each([['2023', '40', { year: 2023, count: 40 }], [' 2026 ', '1', { year: 2026, count: 1 }]])('%s / %s is accepted', (year, count, out) => {
    expect(parseTally(year, count, 2026)).toEqual(out);
  });
  test.each([['2027', '4'], ['1899', '4'], ['23', '4'], ['2023', '0'], ['2023', '10001'], ['2023', '40ish'], ['2023', '2.5'], ['', '']])('%s / %s is refused', (year, count) => {
    expect(parseTally(year, count, 2026).error).toBeTruthy();
  });

  test('year counts are listed newest first, without deleted ones', () => {
    const rows = [tally(2021, 5), book(), tally(2024, 9), tally(2022, 3, { deleted: true })];
    expect(yearCounts(rows).map((row) => row.tallyCount)).toEqual([9, 5]);
  });

  // Year counts add to totals and the per-year chart, but have no authors or ratings to rank, and aren't books.
  test('stats add year counts to the totals and the chart only', () => {
    const rows = [book({ readDate: '2026-03-01', rating: 4, authors: ['Jo'] }), tally(2024, 40), tally(2026, 5)];
    const stats = computeStats(rows, 2026);
    expect(stats).toMatchObject({ total: 1, finished: 46, counted: 45, thisYear: 6, averageRating: 4 });
    expect(stats.byYear).toEqual([{ label: '2026', count: 6 }, { label: '2025', count: 0 }, { label: '2024', count: 40 }]);
    expect(stats.topAuthors).toEqual([{ label: 'Jo', count: 1 }]);
  });

  test('years read include year counts', () => {
    expect(readYears([book({ readDate: '2025-05-05' }), tally(2019, 3), book({ status: 'want', readDate: null })])).toEqual([2025, 2019]);
  });
});

describe('time periods', () => {
  const { computeStats, filterBooks, inPeriod, periodLabel, periodProblem, tallyId, tallyInPeriod } = require('../lib/bookLogic');
  const tally = (year, count) => ({ id: tallyId(year), kind: 'tally', tallyCount: count, status: 'finished', readDate: `${year}-01-01` });

  test('a year keeps only dates in that year', () => {
    expect(inPeriod('2025-12-31', { year: 2025 })).toBe(true);
    expect(inPeriod('2026-01-01', { year: 2025 })).toBe(false);
  });

  // Both ends are included, and either end can be left open.
  test('a range includes both ends and can be open-ended', () => {
    const range = { from: '2025-03-01', to: '2025-06-30' };
    expect(['2025-02-28', '2025-03-01', '2025-06-30', '2025-07-01'].map((d) => inPeriod(d, range))).toEqual([false, true, true, false]);
    expect(inPeriod('2030-01-01', { from: '2025-03-01', to: null })).toBe(true);
    expect(inPeriod('1990-01-01', { from: null, to: '2025-06-30' })).toBe(true);
  });

  // A book not finished yet has no date to place it by.
  test('with a period, a book with no read date is left out', () => {
    expect(inPeriod(null, { year: 2025 })).toBe(false);
    expect(inPeriod(null, null)).toBe(true);
  });

  test('the library filter uses the read date', () => {
    const shelf = [book({ title: 'Old', readDate: '2024-05-01' }), book({ title: 'New', readDate: '2025-05-01' }), book({ title: 'Later', status: 'want', readDate: null })];
    expect(filterBooks(shelf, { period: { year: 2025 } }).map((b) => b.title)).toEqual(['New']);
    expect(filterBooks(shelf, { period: { from: '2024-01-01', to: '2024-12-31' } }).map((b) => b.title)).toEqual(['Old']);
    expect(filterBooks(shelf, {}).map((b) => b.title)).toEqual(['Old', 'New', 'Later']);
  });

  // A year count has no dates inside its year, so a range only includes it when it covers the whole year. Otherwise
  // a June-only range would gain a whole year's books.
  test('a year count is in a range only if the range covers its whole year', () => {
    expect(tallyInPeriod(tally(2024, 40), { from: '2024-01-01', to: '2024-12-31' })).toBe(true);
    expect(tallyInPeriod(tally(2024, 40), { from: '2024-06-01', to: '2024-12-31' })).toBe(false);
    expect(tallyInPeriod(tally(2024, 40), { from: null, to: '2025-01-15' })).toBe(true);
    expect(tallyInPeriod(tally(2024, 40), { year: 2024 })).toBe(true);
    expect(tallyInPeriod(tally(2024, 40), { year: 2025 })).toBe(false);
  });

  test('stats for a period count only what was read in it', () => {
    const rows = [
      book({ readDate: '2025-03-01', rating: 5, authors: ['Jo'] }),
      book({ readDate: '2024-03-01', rating: 1, authors: ['Sam'] }),
      book({ status: 'reading' }),
      tally(2025, 10),
    ];
    const stats = computeStats(rows, 2026, { year: 2025 });
    expect(stats).toMatchObject({ finished: 11, counted: 10, averageRating: 5 });
    expect(stats.topAuthors).toEqual([{ label: 'Jo', count: 1 }]);
    expect(computeStats(rows, 2026, { from: '2025-02-01', to: '2025-04-01' })).toMatchObject({ finished: 1, counted: 0 });
  });

  test('periods are described and a backwards range is pointed out', () => {
    expect(periodLabel(null)).toBe('All time');
    expect(periodLabel({ year: 2025 })).toBe('2025');
    expect(periodLabel({ from: '2025-03-01', to: null })).toMatch(/^Since /);
    expect(periodProblem({ from: '2025-06-01', to: '2025-01-01' })).toMatch(/after/);
    expect(periodProblem({ from: '2025-01-01', to: '2025-06-01' })).toBeNull();
  });
});
