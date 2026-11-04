// lib/bookLogic.js
// The app's book rules, with no screens or storage involved: dates, tidying a book,
// sorting, filtering, search and statistics. Written as a plain module so the test
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
  return { title: '', authors: [], categories: [], status: 'finished', rating: null, readDate: localDate(), notes: '' };
}

/**
 * Works out the date when the status changes in the form: finishing a book with no
 * date uses today, and a book not finished has no read date.
 * In: the new status and current date. Out: the date to use.
 */
function readDateForStatus(status, currentDate) {
  if (status !== 'finished') return null;
  return currentDate || localDate();
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
 * Applies the library's filters.
 * In: books and { status, author, category, rating }, each optional. Out: matches.
 * A rating of 0 means "books with no rating".
 */
function filterBooks(books, { status, author, category, rating } = {}) {
  const has = (names, wanted) => (names || []).some((n) => n.toLowerCase() === wanted.toLowerCase());
  return books.filter((book) => (!status || book.status === status)
    && (!author || has(book.authors, author))
    && (!category || has(book.categories, category))
    && (rating === undefined || rating === null || (book.rating || 0) === rating));
}

/**
 * Global search across title, authors, categories and notes. Every word typed must
 * appear somewhere in the book, so "gaiman stardust" finds that book.
 * In: books and the typed text. Out: matches, with title matches first.
 */
function searchBooks(books, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const haystack = (book) => [book.title, ...(book.authors || []), ...(book.categories || []), book.notes || ''].join(' ').toLowerCase();
  const matches = books.filter((book) => {
    const text = haystack(book);
    return words.every((word) => text.includes(word));
  });
  const titleHit = (book) => words.every((word) => book.title.toLowerCase().includes(word));
  return sortBooks(matches).sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)));
}

/**
 * Counts how many finished books each name appears on.
 * In: finished books, a field, and how many to return. Out: [{ label, count }], most
 * first. Names past the limit are added together as "Other", so the chart stays readable
 * on a phone without hiding those books.
 */
function topNames(books, field, limit) {
  const counts = new Map();
  for (const book of books) {
    for (const name of book[field] || []) {
      const key = name.toLowerCase();
      const entry = counts.get(key) || { label: name, count: 0 };
      entry.count += 1;
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
 * In: live books, and the current year. Out: totals, an average rating (null with no
 * ratings), and per-year, top-author and top-category lists. Only finished books count
 * as read, and the books-per-year list covers every year from the first to the latest,
 * including empty ones, so a gap in reading doesn't vanish from the chart.
 */
function computeStats(books, currentYear = new Date().getFullYear()) {
  const finished = books.filter((book) => book.status === 'finished');
  const rated = finished.filter((book) => book.rating);
  const yearCounts = new Map();
  for (const book of finished) {
    if (book.readDate) {
      const year = Number(book.readDate.slice(0, 4));
      yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
    }
  }
  const years = [...yearCounts.keys()];
  const byYear = [];
  if (years.length) {
    for (let year = Math.max(...years); year >= Math.min(...years); year -= 1) {
      byYear.push({ label: String(year), count: yearCounts.get(year) || 0 });
    }
  }
  return {
    total: books.length,
    finished: finished.length,
    reading: books.filter((book) => book.status === 'reading').length,
    want: books.filter((book) => book.status === 'want').length,
    thisYear: yearCounts.get(currentYear) || 0,
    averageRating: rated.length ? rated.reduce((sum, book) => sum + book.rating, 0) / rated.length : null,
    byYear,
    topAuthors: topNames(finished, 'authors', 5),
    topCategories: topNames(finished, 'categories', 5),
  };
}

module.exports = {
  STATUSES,
  localDate,
  formatDate,
  emptyBook,
  readDateForStatus,
  cleanNames,
  nextEditTime,
  sortBooks,
  distinctNames,
  filterBooks,
  searchBooks,
  computeStats,
};
