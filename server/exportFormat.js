// exportFormat.js
// Turns a list of books into the JSON and CSV export files. It's the one
// implementation of those formats: the server uses it for Nextcloud exports and
// the mobile app imports the same file for its share-sheet export. It must stay
// free of server-only code (no database, no Node modules) for that reason.

const CSV_COLUMNS = ['Title', 'Authors', 'Categories', 'Status', 'Rating', 'Read date', 'Notes', 'Last updated'];
const STATUS_LABELS = { want: 'Want to read', reading: 'Reading', finished: 'Finished' };

/**
 * Makes one value safe for a CSV cell.
 * In: any value. Out: the cell text.
 * Spreadsheets run cells starting with = + - @ (or a tab/return) as formulas, so a
 * book note like =HYPERLINK(...) could do something harmful when the file is opened.
 * A leading apostrophe makes the spreadsheet treat it as plain text. Cells holding
 * a comma, quote or line break are wrapped in quotes, with inner quotes doubled.
 */
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Builds the CSV export, for reading in a spreadsheet.
 * In: an array of books. Out: the file's text. Deleted markers are left out. Several
 * authors or categories share one cell, separated by "; ".
 */
function toCsv(books) {
  const rows = books.filter((book) => !book.deleted).map((book) => [
    book.title,
    (book.authors || []).join('; '),
    (book.categories || []).join('; '),
    STATUS_LABELS[book.status] || book.status,
    book.rating ?? '',
    book.readDate ?? '',
    book.notes ?? '',
    book.updatedAt ?? '',
  ]);
  return [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Builds the JSON export: the complete record of a library.
 * In: an array of books, the app version, and the time as an ISO string.
 * Out: the file's text. Deleted markers are left out.
 */
function toJson(books, appVersion, exportedAt) {
  const live = books.filter((book) => !book.deleted).map((book) => ({
    id: book.id,
    title: book.title,
    authors: book.authors || [],
    categories: book.categories || [],
    status: book.status,
    rating: book.rating ?? null,
    readDate: book.readDate ?? null,
    notes: book.notes ?? '',
    updatedAt: book.updatedAt,
  }));
  return `${JSON.stringify({ app: 'Readeez', appVersion, exportedAt, books: live }, null, 2)}\n`;
}

module.exports = { toCsv, toJson };
