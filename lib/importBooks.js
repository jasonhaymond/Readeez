// lib/importBooks.js
// Reads a Readeez JSON export back in, and decides what to do with each book. Written as a plain module
// so the tests can run it without a phone. The file comes from outside the app and might be edited or
// damaged, so nothing in it is trusted: each book is rebuilt field by field, and anything invalid is
// counted and left out. The limits match server/bookValidation.js.

const { cleanNames, nextEditTime } = require('./bookLogic');

const MAX_BOOKS = 20000;
const MAX_TITLE = 500;
const MAX_NOTES = 20000;
const MAX_NAMES = 20;
const MAX_NAME = 200;
const STATUSES = ['want', 'reading', 'finished'];
// A UUID, e.g. 3f2a9c1e-7b4d-4e8a-9f10-6c2d8e1b5a70.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A calendar date such as 2026-11-04.
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks and rebuilds one book from the file.
 * In: the raw value. Out: a clean book, or null if it's unusable. Only known fields are copied, so a
 * file can't add anything unexpected to a stored book.
 */
function cleanBook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (typeof raw.id !== 'string' || !UUID.test(raw.id) || !title || title.length > MAX_TITLE) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const lists = [raw.authors ?? [], raw.categories ?? []];
  if (lists.some((list) => !Array.isArray(list) || list.length > MAX_NAMES
    || list.some((name) => typeof name !== 'string' || name.length > MAX_NAME))) return null;
  const rating = raw.rating ?? null;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return null;
  const readDate = raw.readDate ?? null;
  if (readDate !== null) {
    if (typeof readDate !== 'string' || !DATE.test(readDate)) return null;
    // Rejects dates that don't exist, such as 2026-02-31, which JavaScript would roll into March.
    const parsed = new Date(`${readDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== readDate) return null;
  }
  const notes = raw.notes ?? '';
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) return null;
  const updatedAt = new Date(raw.updatedAt);
  if (typeof raw.updatedAt !== 'string' || Number.isNaN(updatedAt.getTime())) return null;
  return {
    id: raw.id.toLowerCase(), title, authors: cleanNames(lists[0]), categories: cleanNames(lists[1]),
    status: raw.status, rating, readDate, notes, updatedAt: updatedAt.toISOString(),
  };
}

/**
 * Reads an export file's text.
 * In: the text. Out: { books, invalid }, the usable books and how many were left out.
 * Throws an Error with a message to show if it isn't a Readeez export at all.
 */
function parseExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file isn\'t a Readeez JSON export.');
  }
  if (!data || data.app !== 'Readeez' || !Array.isArray(data.books)) throw new Error('That file isn\'t a Readeez JSON export.');
  if (data.books.length > MAX_BOOKS) throw new Error('That file has too many books to import.');
  const books = data.books.map(cleanBook);
  const usable = books.filter(Boolean);
  return { books: usable, invalid: books.length - usable.length };
}

/**
 * Decides what an import would change, without changing anything.
 * In: the phone's books, the file's books, and the time in milliseconds.
 * Out: { toSave, added, updated, skipped }. A book the phone lacks, or has deleted, is added. A book
 * with a newer copy in the file is updated. A book already as new or newer here is skipped, so importing
 * an old file can't overwrite later edits.
 *
 * Saved books get a new edit time: otherwise a book deleted on another device, with a later deletion
 * time, would win over this deliberate import and vanish again at the next sync.
 */
function planImport(localBooks, fileBooks, nowMs = Date.now()) {
  const local = new Map(localBooks.map((book) => [book.id, book]));
  const toSave = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const book of fileBooks) {
    const existing = local.get(book.id);
    const isNew = !existing || existing.deleted;
    if (!isNew && new Date(existing.updatedAt).getTime() >= new Date(book.updatedAt).getTime()) {
      skipped += 1;
    } else {
      if (isNew) added += 1;
      else updated += 1;
      toSave.push({ ...book, updatedAt: nextEditTime(existing?.updatedAt, nowMs), deleted: false, dirty: true });
    }
  }
  return { toSave, added, updated, skipped };
}

module.exports = { parseExport, planImport };
