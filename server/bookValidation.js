// bookValidation.js
// Checks and tidies one book a phone sends during sync, before it reaches the
// database. A client can send anything, so nothing about its format is trusted.
// Used by routes/sync.js.

const MAX_TITLE = 500;
const MAX_NOTES = 20000;
const MAX_NAMES = 20;
const MAX_NAME = 200;
const STATUSES = ['want', 'reading', 'finished'];
// A UUID, the id format phones generate, e.g. 3f2a9c1e-7b4d-4e8a-9f10-6c2d8e1b5a70.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A calendar date such as 2026-11-04.
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tidies a list of author or category names: trims them and drops blanks and
 * repeats (ignoring upper/lower case).
 * In: the value sent. Out: a clean array, or null if it isn't valid.
 */
function cleanNames(value) {
  if (!Array.isArray(value) || value.length > MAX_NAMES) return null;
  const seen = new Set();
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const name = item.trim();
    if (name.length > MAX_NAME) return null;
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

/**
 * Confirms text is a date that really exists. 2026-02-31 fits the pattern, but
 * JavaScript would roll it over to March, so the result is compared back.
 * In: text. Out: true or false.
 */
function isRealDate(text) {
  if (typeof text !== 'string' || !DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Validates one incoming book.
 * In: whatever the client sent, and the current time (a Date).
 * Out: { book } with safe values, or { error } with the reason. A book marked
 * deleted has its contents emptied here, so a deleted book's notes don't linger on
 * the server.
 */
function validateBook(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'not an object' };
  if (typeof input.id !== 'string' || !UUID.test(input.id)) return { error: 'bad id' };

  const editedAt = new Date(input.updatedAt);
  if (typeof input.updatedAt !== 'string' || Number.isNaN(editedAt.getTime())) return { error: 'bad updatedAt' };
  // A phone with its clock set ahead must not win every future conflict, so an
  // edit can't be dated later than the moment the server receives it.
  const updatedAt = editedAt > now ? now : editedAt;

  if (input.deleted === true) {
    return {
      book: {
        id: input.id.toLowerCase(), title: '', authors: [], categories: [], status: 'finished',
        rating: null, readDate: null, notes: '', updatedAt, deleted: true,
      },
    };
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > MAX_TITLE) return { error: 'bad title' };
  const authors = cleanNames(input.authors);
  const categories = cleanNames(input.categories);
  if (!authors || !categories) return { error: 'bad authors or categories' };
  if (!STATUSES.includes(input.status)) return { error: 'bad status' };
  const rating = input.rating ?? null;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return { error: 'bad rating' };
  const readDate = input.readDate ?? null;
  if (readDate !== null && !isRealDate(readDate)) return { error: 'bad readDate' };
  const notes = input.notes ?? '';
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) return { error: 'bad notes' };

  return {
    book: {
      id: input.id.toLowerCase(), title, authors, categories, status: input.status,
      rating, readDate, notes, updatedAt, deleted: false,
    },
  };
}

module.exports = { validateBook, UUID };
