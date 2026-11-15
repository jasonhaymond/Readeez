// lib/bookLogic.js
// The app's book rules, with no screens or storage involved: dates, tidying a book,
// year counts, time periods, sorting, filtering, search and statistics. Written as a plain module so the test
// suite can run it without a phone. Used by the screens and by BooksContext.

const STATUSES = [
  { id: 'finished', label: 'Finished' },
  { id: 'reading', label: 'Reading' },
  { id: 'want', label: 'Want to read' },
];

/**
 * Today's date on this phone, as 'YYYY-MM-DD'. Built from local date parts: the
 * toISOString shortcut gives the UTC date, which is tomorrow during a US evening.
 * In: optionally a Date. Out: the date text.
 */
function localDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Formats 'YYYY-MM-DD' for reading, e.g. 'Nov 4, 2026'.
 * In: date text or null. Out: display text, or '' if empty. The parts are passed
 * separately so the date is read as local, and can't shift by a day.
 */
function formatDate(text) {
  if (!text) return '';
  const [year, month, day] = text.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A blank book for the add form. The read date defaults to the day of entry.
 * Out: form values.
 */
function emptyBook() {
  return { title: '', series: '', authors: [], categories: [], status: 'finished', rating: null, categoryRatings: [], boxTotal: null, boxRead: null, boxTitles: [], readDate: localDate(), notes: '' };
}

/**
 * Works out the date when the status or a box's read count changes in the form: finishing a book with no
 * date uses today, and a book not finished has no read date. The exception is a box still being read: the books
 * read from it so far count in the stats, so they need a date to count under.
 * In: the new status, current date, and the number of books read from a box, if any. Out: the date to use.
 */
function readDateForStatus(status, currentDate, boxRead = 0) {
  if (status !== 'finished' && !boxRead) return null;
  return currentDate || localDate();
}

/**
 * Reads the two box fields as typed on the form.
 * In: the text in the "books in the box" and "books read" fields, and the book's status. Leaving "books read" blank on a
 * finished box means all of them, because that's what finished says, and new books start as finished. A typed 0 stays 0.
 * Out: { boxTotal, boxRead } (both null when the first is blank, meaning an ordinary book), or { error } with a message
 * to show. Whole digits only, so "2.5" or "3 books" is a typing mistake to point out rather than guess at. Matches
 * the limits in server/bookValidation.js.
 */
function parseBox(totalText, readText, status) {
  const total = String(totalText ?? '').trim();
  const typedRead = String(readText ?? '').trim();
  const read = typedRead || (status === 'finished' ? total : '');
  if (!total) return read ? { error: 'Enter how many books are in the box.' } : { boxTotal: null, boxRead: null };
  // Digits only, e.g. "12".
  if (!/^\d{1,4}$/.test(total) || Number(total) < 2 || Number(total) > 1000) return { error: 'A box holds from 2 to 1000 books.' };
  if (read && !/^\d{1,4}$/.test(read)) return { error: 'Enter how many of the box\'s books you\'ve read as a number.' };
  if (Number(read) > Number(total)) return { error: 'You can\'t have read more books than the box holds.' };
  return { boxTotal: Number(total), boxRead: Number(read) };
}

/**
 * Checks the optional titles of a box's books against its size, for the form.
 * In: the titles and the box's size (null for an ordinary book). Out: a message to show, or null if they're fine.
 * The titles of something that's no longer a box are simply dropped when saving, so that's not a mistake.
 */
function boxTitlesProblem(titles, boxTotal) {
  if (boxTotal && titles.length > boxTotal) return `You've listed ${titles.length} titles, but the box holds ${boxTotal} books.`;
  return null;
}

// Year counts: how many books someone read in a year before they started using Readeez. Each one is stored as a row
// with the books (kind 'tally') so it syncs and backs up like one, but it never appears in the library or search.
const MIN_TALLY_YEAR = 1900;
const MAX_TALLY = 10000;

/** True if the row is a year count rather than a book. In: a row. Out: true or false. */
const isTally = (book) => book.kind === 'tally';

/**
 * The fixed id a year's count always uses, e.g. 00000000-0000-4000-8000-000000002023. One id per year means the same
 * year added on two offline devices becomes one count (the later edit wins), not two. Matches server/bookValidation.js.
 * In: a year as a number. Out: the id text.
 */
function tallyId(year) {
  return `00000000-0000-4000-8000-${String(year).padStart(12, '0')}`;
}

/** The title stored on a year count, which the server also sets. In: a year. Out: text. */
function tallyTitle(year) {
  return `Books read in ${year} before Readeez`;
}

/** The year a year count is for. In: a year-count row. Out: the year as a number. */
const tallyYear = (tally) => Number(String(tally.readDate).slice(0, 4));

/**
 * Reads the year and count typed into the year-count form.
 * In: the two texts, and the current year. Out: { year, count } as numbers, or { error } with a message to show.
 * Whole digits only, so "40ish" is pointed out rather than guessed at. A year count can be for this year too, for the
 * books read before starting with the app. Matches the limits in server/bookValidation.js.
 */
function parseTally(yearText, countText, currentYear = new Date().getFullYear()) {
  const year = String(yearText ?? '').trim();
  const count = String(countText ?? '').trim();
  // Four digits, e.g. "2023".
  if (!/^\d{4}$/.test(year) || Number(year) < MIN_TALLY_YEAR || Number(year) > currentYear) {
    return { error: `Enter a year from ${MIN_TALLY_YEAR} to ${currentYear}.` };
  }
  // One to five digits, e.g. "40".
  if (!/^\d{1,5}$/.test(count) || Number(count) < 1 || Number(count) > MAX_TALLY) {
    return { error: `Enter how many books you read, from 1 to ${MAX_TALLY}.` };
  }
  return { year: Number(year), count: Number(count) };
}

/**
 * Lists the year counts, newest year first. In: rows. Out: the live year counts.
 */
function yearCounts(rows) {
  return rows.filter((row) => isTally(row) && !row.deleted).sort((a, b) => tallyYear(b) - tallyYear(a));
}

/**
 * How many books a library entry counts as having been read. An ordinary book counts once it's finished. A box counts
 * the books read from it, whatever its status, so a box still being read adds to the stats as it goes. A year count
 * counts as its number.
 * In: a book. Out: a whole number.
 */
function readCount(book) {
  if (isTally(book)) return book.tallyCount || 0;
  if (book.boxTotal) return book.boxRead || 0;
  return book.status === 'finished' ? 1 : 0;
}

/**
 * Keeps only valid stars for a book's categories: one each, for categories it still has, spelled as on the book.
 * Removing a category therefore removes its rating. Matches server/bookValidation.js.
 * In: the ratings and the book's categories. Out: [{ category, rating }]. A Map does the lookup, so a category called
 * "__proto__" is ordinary text.
 */
function cleanCategoryRatings(ratings, categories) {
  const names = new Map((categories || []).map((name) => [name.toLowerCase(), name]));
  const seen = new Set();
  const out = [];
  for (const item of ratings || []) {
    const key = String(item?.category ?? '').trim().toLowerCase();
    if (names.has(key) && !seen.has(key) && Number.isInteger(item.rating) && item.rating >= 1 && item.rating <= 5) {
      seen.add(key);
      out.push({ category: names.get(key), rating: item.rating });
    }
  }
  return out;
}

/**
 * Sets or clears one category's stars.
 * In: the current ratings, the category, and 1 to 5, or null to clear. Out: a new list.
 */
function setCategoryRating(ratings, category, rating) {
  const others = (ratings || []).filter((item) => item.category.toLowerCase() !== category.toLowerCase());
  return rating ? [...others, { category, rating }] : others;
}

/**
 * Averages the stars given to each category across the library.
 * In: books. Out: [{ label, count, ratings }], highest average first, where count holds the average and ratings how many
 * books it's based on.
 */
function categoryAverages(books) {
  const totals = new Map();
  for (const book of books) {
    for (const { category, rating } of book.categoryRatings || []) {
      const key = category.toLowerCase();
      const entry = totals.get(key) || { label: category, sum: 0, ratings: 0 };
      entry.sum += rating;
      entry.ratings += 1;
      totals.set(key, entry);
    }
  }
  return [...totals.values()]
    .map(({ label, sum, ratings }) => ({ label, count: sum / ratings, ratings }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Trims names and drops blanks and repeats, ignoring upper/lower case. Matches what
 * the server does, so a book doesn't change after it syncs.
 * In: an array of names. Out: the tidy array.
 */
function cleanNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

/**
 * The time to stamp on an edit. Normally now, but always later than the previous
 * edit, so that an edit on a phone whose clock runs slow isn't discarded when it
 * syncs (the later time wins, see server/routes/sync.js).
 * In: the book's previous time (ISO text or undefined) and the current time in
 * milliseconds. Out: ISO text.
 */
function nextEditTime(previous, nowMs = Date.now()) {
  const prior = previous ? new Date(previous).getTime() : 0;
  return new Date(Math.max(nowMs, prior + 1)).toISOString();
}

/**
 * The date a book sorts by: its read date, or otherwise when it was last edited.
 * In: a book. Out: text starting 'YYYY-MM-DD', which sorts correctly as text.
 */
const sortDate = (book) => book.readDate || String(book.updatedAt || '').slice(0, 10);

/**
 * Orders the library with the most recently read first. Books with the same date put the
 * latest edit first, so a book just added appears at the top rather than mid-list.
 * In: an array of books. Out: a new sorted array.
 */
function sortBooks(books) {
  return [...books].sort((a, b) => sortDate(b).localeCompare(sortDate(a))
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || a.title.localeCompare(b.title));
}

/**
 * Lists every distinct name used across the library, for filters and suggestions.
 * In: books and the field ('authors' or 'categories'). Out: names, A to Z.
 */
function distinctNames(books, field) {
  const byKey = new Map();
  for (const book of books) {
    for (const name of book[field] || []) {
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, name);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Lists every distinct series name used across the library, for the filter and the book form's suggestions.
 * In: books. Out: names, A to Z, spelled as first seen.
 */
function distinctSeries(books) {
  const byKey = new Map();
  for (const book of books) {
    const name = (book.series || '').trim();
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

// A time period limits books by their read date. It's one of:
//   null                                       all time
//   { year: 2025 }                             one calendar year
//   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }   a custom range, including both ends; either end may be null (open-ended)

/**
 * Whether a read date falls inside a period. Dates are 'YYYY-MM-DD' text, which compares correctly as text.
 * In: the date (or null) and the period. Out: true or false. With a period chosen, something with no read date
 * (a book not finished yet) is outside it, because there's no date to place it by.
 */
function inPeriod(readDate, period) {
  if (!period) return true;
  if (!readDate) return false;
  if (period.year) return readDate.slice(0, 4) === String(period.year);
  return (!period.from || readDate >= period.from) && (!period.to || readDate <= period.to);
}

/**
 * Whether a year count belongs in a period. It covers a whole year with no dates inside it, so a custom range only
 * includes it when the range covers that whole year. Otherwise it would add, say, a year's 40 books to a June total.
 * In: a year count and the period. Out: true or false.
 */
function tallyInPeriod(tally, period) {
  if (!period) return true;
  const year = tallyYear(tally);
  if (period.year) return year === period.year;
  return (!period.from || period.from <= `${year}-01-01`) && (!period.to || period.to >= `${year}-12-31`);
}

/**
 * The problem with a custom range, if any, to show beside it. In: the period. Out: a message, or null.
 */
function periodProblem(period) {
  if (period && period.from && period.to && period.from > period.to) return 'The start date is after the end date.';
  return null;
}

/**
 * Describes a period for a button or heading, e.g. "2025", "Since Mar 1, 2025" or "Jan 1, 2024 – Jun 30, 2024".
 * In: the period. Out: text.
 */
function periodLabel(period) {
  if (!period) return 'All time';
  if (period.year) return String(period.year);
  if (period.from && period.to) return `${formatDate(period.from)} – ${formatDate(period.to)}`;
  if (period.from) return `Since ${formatDate(period.from)}`;
  if (period.to) return `Until ${formatDate(period.to)}`;
  return 'All time';
}

/**
 * Every year something was read in, for the period choices: from read dates and year counts.
 * In: books and year counts together. Out: years as numbers, newest first.
 */
function readYears(rows) {
  const years = new Set();
  for (const row of rows) {
    if (row.readDate && readCount(row) > 0) years.add(Number(row.readDate.slice(0, 4)));
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Applies the library's filters.
 * In: books and { status, author, category, rating, series, period }, each optional. Out: matches.
 * A rating of 0 means "books with no rating". A period keeps books whose read date falls in it (see inPeriod).
 */
function filterBooks(books, { status, author, category, rating, series, period } = {}) {
  const has = (names, wanted) => (names || []).some((n) => n.toLowerCase() === wanted.toLowerCase());
  return books.filter((book) => (!status || book.status === status)
    && (!author || has(book.authors, author))
    && (!category || has(book.categories, category))
    && (!series || (book.series || '').toLowerCase() === series.toLowerCase())
    && (rating === undefined || rating === null || (book.rating || 0) === rating)
    && inPeriod(book.readDate, period));
}

/**
 * Global search across title, series, authors, categories, notes and the titles of a box's books. Every word typed must
 * appear somewhere in the book, so "gaiman stardust" finds that book.
 * In: books and the typed text. Out: matches, with title matches first.
 */
function searchBooks(books, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const haystack = (book) => [book.title, book.series || '', ...(book.authors || []), ...(book.categories || []), ...(book.boxTitles || []), book.notes || ''].join(' ').toLowerCase();
  const matches = books.filter((book) => {
    const text = haystack(book);
    return words.every((word) => text.includes(word));
  });
  const titleHit = (book) => words.every((word) => book.title.toLowerCase().includes(word));
  return sortBooks(matches).sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)));
}

/**
 * Counts how many read books each name appears on, so a box counts for each book read from it.
 * In: books with something read, a field, and how many to return. Out: [{ label, count }], most
 * first. Names past the limit are added together as "Other", so the chart stays readable
 * on a phone without hiding those books.
 */
function topNames(books, field, limit) {
  const counts = new Map();
  for (const book of books) {
    for (const name of book[field] || []) {
      const key = name.toLowerCase();
      const entry = counts.get(key) || { label: name, count: 0 };
      entry.count += readCount(book);
      counts.set(key, entry);
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((sum, entry) => sum + entry.count, 0);
  return rest ? [...top, { label: 'Other', count: rest }] : top;
}

/**
 * Works out everything on the Stats screen.
 * In: live books and year counts together, the current year, and optionally a period (see inPeriod) to limit it to.
 * Out: totals, an average rating (null with no ratings), and per-year, top-author, top-category and category-rating
 * lists, plus `counted`, how many of the books read come from year counts. Only finished books, the books read from a
 * box, and year counts count as read, and a box's books all count under its one read date. Year counts add to the
 * totals and the books-per-year chart only: they have no authors, categories or ratings. With a period, books read
 * in it count, and year counts only if it covers their whole year (see tallyInPeriod). The books-per-year list covers
 * every year from the first to the latest, including empty ones, so a gap in reading doesn't vanish from the chart.
 */
function computeStats(rows, currentYear = new Date().getFullYear(), period = null) {
  const books = rows.filter((row) => !isTally(row));
  const tallies = rows.filter((row) => isTally(row) && tallyInPeriod(row, period));
  const read = books.filter((book) => readCount(book) > 0 && inPeriod(book.readDate, period));
  const rated = read.filter((book) => book.rating);
  const perYear = new Map();
  for (const entry of [...read, ...tallies]) {
    if (entry.readDate) {
      const year = Number(entry.readDate.slice(0, 4));
      perYear.set(year, (perYear.get(year) || 0) + readCount(entry));
    }
  }
  const years = [...perYear.keys()];
  const byYear = [];
  if (years.length) {
    for (let year = Math.max(...years); year >= Math.min(...years); year -= 1) {
      byYear.push({ label: String(year), count: perYear.get(year) || 0 });
    }
  }
  const counted = tallies.reduce((sum, tally) => sum + readCount(tally), 0);
  return {
    total: books.length,
    finished: read.reduce((sum, book) => sum + readCount(book), 0) + counted,
    counted,
    reading: books.filter((book) => book.status === 'reading').length,
    want: books.filter((book) => book.status === 'want').length,
    thisYear: perYear.get(currentYear) || 0,
    averageRating: rated.length ? rated.reduce((sum, book) => sum + book.rating, 0) / rated.length : null,
    byYear,
    topAuthors: topNames(read, 'authors', 5),
    topCategories: topNames(read, 'categories', 5),
    // All time includes books rated before being finished, as it always has. A period uses only the books read in it.
    categoryRatings: categoryAverages(period ? read : books),
  };
}

/**
 * Combines the books just read from the phone with any saved while that read was underway. The read lists its books
 * at the start, so it can miss those, and replacing the list would drop them from the screen and from the next sync.
 * In: the books read, and the books edited during the read. Out: one list, where an edit replaces the copy read.
 */
function mergeLoadedBooks(loaded, editedDuringLoad) {
  const byId = new Map(loaded.map((book) => [book.id, book]));
  editedDuringLoad.forEach((book) => byId.set(book.id, book));
  return [...byId.values()];
}

module.exports = {
  STATUSES,
  localDate,
  formatDate,
  emptyBook,
  readDateForStatus,
  parseBox,
  boxTitlesProblem,
  readCount,
  isTally,
  tallyId,
  tallyTitle,
  tallyYear,
  parseTally,
  yearCounts,
  distinctSeries,
  inPeriod,
  tallyInPeriod,
  periodProblem,
  periodLabel,
  readYears,
  cleanCategoryRatings,
  setCategoryRating,
  categoryAverages,
  cleanNames,
  nextEditTime,
  sortBooks,
  distinctNames,
  filterBooks,
  searchBooks,
  computeStats,
  mergeLoadedBooks,
};
