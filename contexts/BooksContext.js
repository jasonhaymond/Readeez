// contexts/BooksContext.js
// The live library every screen reads from.
//
// On a phone, edits are saved to the phone at once, so the app never waits on the network, and
// then synced in the background: shortly after an edit, when the app returns to the foreground, and on request.
//
// In a browser, which keeps books only in memory, an edit isn't finished until the server has it. If it can't reach
// the server, the edit is undone and reported, rather than being held in a tab that could close and lose it.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../lib/api';
import * as store from '../lib/bookStore';
import { runSync } from '../lib/syncEngine';
import { cleanCategoryRatings, cleanNames, mergeLoadedBooks, nextEditTime, sortBooks } from '../lib/bookLogic';
import { useAuth } from './AuthContext';

// Gathers a quick run of edits into one sync, rather than one request per edit.
const SYNC_DELAY_MS = 1500;
const ONLINE_ONLY = Platform.OS === 'web';
const BooksContext = createContext(null);

/**
 * Wraps the signed-in part of the app.
 * In: children. Side effects: reads and writes books on the device, talks to the server.
 */
export function BooksProvider({ children }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [allBooks, setAllBooks] = useState([]);
  const [ready, setReady] = useState(false);
  // 'idle', 'syncing', 'offline' or 'error', with a message for the last two.
  const [sync, setSync] = useState({ state: 'idle', message: null, lastAt: null });
  // useRef holds a value between redraws without causing one. The latest list lives here
  // too, so a sync always compares against the newest copy.
  const booksRef = useRef([]);
  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef(null);
  // The sync underway, so a browser's save can wait its turn.
  const underway = useRef(Promise.resolve());
  // True once this account's books have loaded from the phone.
  const loaded = useRef(false);

  /** Replaces the given books in the in-memory list and updates the screens. */
  const applyBooks = useCallback((changed) => {
    const byId = new Map(booksRef.current.map((book) => [book.id, book]));
    changed.forEach((book) => byId.set(book.id, book));
    booksRef.current = [...byId.values()];
    setAllBooks(booksRef.current);
  }, []);

  /**
   * Exchanges changes with the server once.
   * Out: { rejected }. Throws if the server can't be reached. A sign-out during the exchange makes its writes do
   * nothing (see bookStore.js), and the erase count is taken here, when it starts, for that comparison.
   */
  const exchange = useCallback(() => {
    const startedAt = store.eraseCount(userId);
    return runSync({
      getBooks: async () => booksRef.current,
      putBooks: async (books) => { applyBooks(books); await store.saveBooks(userId, books, startedAt); },
      getCursor: () => store.loadCursor(userId),
      setCursor: (cursor) => store.saveCursor(userId, cursor, startedAt),
      getEpoch: () => store.loadEpoch(userId),
      setEpoch: (epoch) => store.saveEpoch(userId, epoch, startedAt),
      post: (body) => api.request('POST', '/api/sync', body),
    });
  }, [userId, applyBooks]);

  /**
   * Runs a sync. If one is already underway, another follows it, so an edit made during
   * a sync isn't left waiting. A failure just updates the status: on a phone the books are safe
   * there and go up on a later try.
   *
   * Nothing runs until the books have loaded, however it was triggered. A sync started during loading would compare
   * against an empty list, and could save a sync position just after loading cleared it to fetch an unreadable book
   * again, leaving that book missing. Loading runs a sync itself when it finishes, so nothing is missed. If loading
   * fails, it reports that in the sync status, which the Library screen shows, and syncing stays off until the app restarts: with the stored
   * books unknown, a sync couldn't tell which ones still have changes to send.
   */
  const syncNow = useCallback(() => {
    if (!userId || !loaded.current) return Promise.resolve();
    if (running.current) { again.current = true; return underway.current; }
    running.current = true;
    setSync((s) => ({ ...s, state: 'syncing', message: null }));
    underway.current = (async () => {
      try {
        const { rejected } = await exchange();
        // A browser has nothing to show until its first download finishes.
        if (ONLINE_ONLY) setReady(true);
        setSync({
          state: rejected.length ? 'error' : 'idle',
          message: rejected.length ? `${rejected.length} book(s) couldn't be saved to the server.` : null,
          lastAt: new Date().toISOString(),
        });
      } catch (err) {
        setSync((s) => ({ ...s, state: err.status === 0 ? 'offline' : 'error', message: err.message }));
      } finally {
        running.current = false;
        if (again.current) {
          again.current = false;
          syncNow();
        }
      }
    })();
    return underway.current;
  }, [userId, exchange]);

  /** Schedules a sync soon, restarting the wait if another edit arrives first. */
  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(syncNow, SYNC_DELAY_MS);
  }, [syncNow]);

  /**
   * Makes a browser's edit, which only counts once the server has it.
   * In: the changed books. Throws an Error with a message to show if it failed.
   * Side effects: shows the change, sends it, and undoes any part the server didn't receive. Books already accepted
   * stay, so a large import that fails partway keeps what arrived, and importing again only sends the rest.
   */
  const saveOnline = useCallback(async (changed) => {
    if (!ready) throw new Error(sync.message || 'Your books are still loading.');
    const before = new Map(changed.map((book) => [book.id, booksRef.current.find((other) => other.id === book.id)]));
    applyBooks(changed);
    // Waits for a sync underway, which started before this edit and wouldn't have sent it.
    while (running.current) await underway.current;
    running.current = true;
    setSync((s) => ({ ...s, state: 'syncing', message: null }));
    let problem = null;
    try {
      const { rejected } = await exchange();
      if (rejected.length) problem = new Error('The server wouldn\'t accept that. Check it and try again.');
      else setSync({ state: 'idle', message: null, lastAt: new Date().toISOString() });
    } catch (err) {
      problem = err;
    } finally {
      running.current = false;
    }
    if (!problem) return;
    // Anything still marked unsent didn't arrive, so it goes back to how it was, and a new book goes away.
    const stillUnsent = new Set(booksRef.current.filter((book) => book.dirty && before.has(book.id)).map((book) => book.id));
    booksRef.current = booksRef.current
      .filter((book) => !(stillUnsent.has(book.id) && !before.get(book.id)))
      .map((book) => (stillUnsent.has(book.id) ? before.get(book.id) : book));
    setAllBooks(booksRef.current);
    setSync((s) => ({ ...s, state: problem.status === 0 ? 'offline' : 'error', message: problem.message }));
    throw problem;
  }, [ready, sync.message, applyBooks, exchange]);

  /**
   * Records an edit in whichever way this device works.
   * In: the changed books. On a phone: saves them there straight away, and schedules a sync.
   */
  const commit = useCallback(async (changed) => {
    if (ONLINE_ONLY) {
      await saveOnline(changed);
      return;
    }
    applyBooks(changed);
    await store.saveBooks(userId, changed);
    scheduleSync();
  }, [userId, applyBooks, scheduleSync, saveOnline]);

  // Loads this account's books when someone signs in, then syncs. If the account changes
  // while loading, `cancelled` stops one person's books appearing under another's name.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    loaded.current = false;
    booksRef.current = [];
    setAllBooks([]);
    if (!userId) return undefined;
    store.loadBooks(userId).then((books) => {
      if (cancelled) return;
      // The list was emptied above, so anything in it now was saved during the load.
      booksRef.current = mergeLoadedBooks(books, booksRef.current);
      setAllBooks(booksRef.current);
      // A browser starts empty, so it's ready only once the first sync has downloaded the library. See syncNow.
      if (!ONLINE_ONLY) setReady(true);
      loaded.current = true;
      syncNow();
    }).catch((err) => {
      if (cancelled) return;
      console.warn(`Could not load books: ${err.message}`);
      setSync((s) => ({ ...s, state: 'error', message: "Couldn't read your books on this phone. Restart the app." }));
    });
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [userId, syncNow]);

  // Syncs whenever the app comes back to the foreground, to pick up other devices' edits.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncNow();
    });
    return () => subscription.remove();
  }, [syncNow]);

  /**
   * Adds or updates a book.
   * In: form values, with `id` when editing. Out: the saved book. Throws if it couldn't be saved.
   * Side effects: see commit.
   */
  const saveBook = useCallback(async (values) => {
    const existing = values.id ? booksRef.current.find((book) => book.id === values.id) : null;
    const categories = cleanNames(values.categories);
    const book = {
      id: values.id || randomUUID(),
      title: values.title.trim(),
      authors: cleanNames(values.authors),
      categories,
      status: values.status,
      rating: values.rating ?? null,
      categoryRatings: cleanCategoryRatings(values.categoryRatings, categories),
      boxTotal: values.boxTotal ?? null,
      boxRead: values.boxRead ?? null,
      // Only a box has these, so clearing its size clears them too.
      boxTitles: values.boxTotal ? cleanNames(values.boxTitles) : [],
      readDate: values.readDate ?? null,
      notes: values.notes || '',
      updatedAt: nextEditTime(existing?.updatedAt),
      deleted: false,
      dirty: true,
    };
    await commit([book]);
    return book;
  }, [commit]);

  /**
   * Deletes a book. It stays on the device as an emptied marker until the server has heard,
   * so other devices learn it's gone.
   * In: the book's id. Side effects: see commit. Throws if it couldn't be deleted.
   */
  const deleteBook = useCallback(async (id) => {
    const existing = booksRef.current.find((book) => book.id === id);
    if (!existing) return;
    await commit([{
      id, title: '', authors: [], categories: [], status: 'finished', rating: null, categoryRatings: [], boxTotal: null,
      boxRead: null, boxTitles: [], readDate: null, notes: '', updatedAt: nextEditTime(existing.updatedAt), deleted: true, dirty: true,
    }]);
  }, [commit]);

  /**
   * Saves books from an import, already planned by lib/importBooks.js.
   * In: the books to save. Side effects: see commit. Throws if they couldn't be saved.
   */
  const importBooks = useCallback((books) => commit(books), [commit]);

  const value = useMemo(() => ({
    // What screens display: live books only, most recently read first.
    books: sortBooks(allBooks.filter((book) => !book.deleted)),
    // Everything, including deleted markers, which an import needs to compare against.
    allBooks,
    pendingCount: allBooks.filter((book) => book.dirty).length,
    ready,
    sync,
    syncNow,
    saveBook,
    deleteBook,
    importBooks,
  }), [allBooks, ready, sync, syncNow, saveBook, deleteBook, importBooks]);

  return <BooksContext.Provider value={value}>{children}</BooksContext.Provider>;
}

/** Reads the library inside a component. */
export const useBooks = () => useContext(BooksContext);
