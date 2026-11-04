// lib/syncEngine.js
// Exchanges changes with the server: sends books edited on this phone, and applies
// what changed elsewhere. It's handed its storage and network functions rather than
// importing them, so the test suite can run every case with no phone or server.
// BooksContext.js calls it. The server's half is server/routes/sync.js.

// Books per request. The server accepts 500; fewer keeps each request small on a
// mobile connection.
const PUSH_BATCH = 200;
// Stops a misbehaving server from keeping this loop running forever.
const MAX_ROUNDS = 200;

/**
 * Decides what to keep when the server sends a book.
 * In: the local book (or undefined), the server's book, and pushedAt, the updatedAt of
 * the local version sent in this same exchange (or undefined).
 * Out: the book to store, with its dirty flag set. "dirty" means not yet on the server.
 *
 * The one case that keeps the local copy: it has unsent edits made after this exchange
 * started. Taking the server's copy there would lose what the person just typed. In
 * every other case the server has already judged which edit wins.
 */
function mergeServerBook(local, server, pushedAt) {
  if (local && local.dirty && local.updatedAt !== pushedAt) return local;
  return { ...server, dirty: false };
}

/**
 * Runs one full sync.
 * In: an object of functions:
 *   getBooks()            every local book, including deleted markers
 *   putBooks(books)       saves changed books
 *   getCursor()           the saved position, or null
 *   setCursor(text)       saves the position
 *   getEpoch()            the server's restore id from the last sync, or null
 *   setEpoch(text)        saves it
 *   post(body)            sends { cursor, epoch, changes } and returns the server's answer
 * Out: { rejected }, ids the server refused. Those stay unsent rather than being lost.
 * Throws if the network or server fails. Everything finished so far is already saved,
 * and the next run carries on from there.
 */
async function runSync({ getBooks, putBooks, getCursor, setCursor, getEpoch, setEpoch, post }) {
  let cursor = (await getCursor()) || '0';
  let epoch = (await getEpoch()) || undefined;
  const rejected = new Set();
  // Books already sent in this run, so a book the server won't accept isn't resent in
  // a loop, and so a book edited mid-run waits for the next sync.
  const attempted = new Set();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const books = await getBooks();
    const dirty = books.filter((book) => book.dirty && !attempted.has(book.id)).slice(0, PUSH_BATCH);
    const pushedAt = new Map(dirty.map((book) => [book.id, book.updatedAt]));
    dirty.forEach((book) => attempted.add(book.id));

    // The dirty flag is local bookkeeping, so it's removed before sending.
    const changes = dirty.map(({ dirty: _dirty, ...book }) => book);
    const answer = await post({ cursor, epoch, changes });
    const refused = new Set((answer.rejected || []).map((item) => item.id));
    refused.forEach((id) => rejected.add(id));

    // Re-read, because the person may have edited something while the request ran.
    const current = new Map((await getBooks()).map((book) => [book.id, book]));
    const toSave = new Map();
    for (const server of answer.changes || []) {
      const merged = mergeServerBook(current.get(server.id), server, pushedAt.get(server.id));
      toSave.set(server.id, merged);
    }
    // Sent, accepted, and not sent back, with no newer edit: now safely on the server.
    for (const [id, sentAt] of pushedAt) {
      const book = current.get(id);
      if (!toSave.has(id) && !refused.has(id) && book && book.updatedAt === sentAt) {
        toSave.set(id, { ...book, dirty: false });
      }
    }
    // After a server restore it may have lost recent books. Marking everything unsent
    // re-uploads them; the server's newest-wins rule ignores any it already has.
    if (answer.reset) {
      for (const book of current.values()) {
        if (!toSave.has(book.id)) toSave.set(book.id, { ...book, dirty: true });
      }
      attempted.clear();
    }
    if (toSave.size) await putBooks([...toSave.values()]);
    cursor = answer.cursor;
    await setCursor(cursor);
    if (answer.epoch) {
      epoch = answer.epoch;
      await setEpoch(epoch);
    }

    // Finished when the server has no more to send and every unsent book has been tried.
    const remaining = (await getBooks()).some((book) => book.dirty && !attempted.has(book.id));
    if (!answer.more && !remaining) break;
  }
  return { rejected: [...rejected] };
}

module.exports = { mergeServerBook, runSync, PUSH_BATCH };
