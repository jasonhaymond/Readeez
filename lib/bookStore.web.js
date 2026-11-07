// lib/bookStore.web.js
// The browser's version of bookStore.js, chosen automatically by Expo when it builds the web version. A browser has no
// equivalent of Android's Keystore, and may be on a computer other people use, so books are held only in the page's
// memory and come from the server each time. Closing the tab leaves none of them behind. Only the sync position is
// kept here, so a sync during a visit fetches only what changed.

const positions = new Map();

/** A browser writes nothing to storage, so there's nothing for a late sync to put back. Out: always 0. */
export const eraseCount = () => 0;

/** Starts each visit empty, as the first sync downloads everything. Out: an empty list. */
export async function loadBooks() {
  return [];
}

/** Nothing to save: BooksContext holds the books in memory. */
export async function saveBooks() {}

export const loadCursor = async (userId) => positions.get(`${userId}:cursor`) ?? null;
export const saveCursor = async (userId, cursor) => { positions.set(`${userId}:cursor`, cursor); };
export const loadEpoch = async (userId) => positions.get(`${userId}:epoch`) ?? null;
export const saveEpoch = async (userId, epoch) => { positions.set(`${userId}:epoch`, epoch); };

/** Forgets the sync positions at sign-out. In: the account id. */
export async function clearAccount(userId) {
  positions.delete(`${userId}:cursor`);
  positions.delete(`${userId}:epoch`);
}
