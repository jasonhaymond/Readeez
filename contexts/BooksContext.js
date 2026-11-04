// contexts/BooksContext.js
// The live library every screen reads from. Edits are saved to the phone at once, so
// the app never waits on the network, and then synced in the background: shortly after
// an edit, when the app returns to the foreground, and on request.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../lib/api';
import * as store from '../lib/bookStore';
import { runSync } from '../lib/syncEngine';
import { cleanNames, nextEditTime, sortBooks } from '../lib/bookLogic';
import { useAuth } from './AuthContext';

// Gathers a quick run of edits into one sync, rather than one request per edit.
const SYNC_DELAY_MS = 1500;
const BooksContext = createContext(null);

/**
 * Wraps the signed-in part of the app.
 * In: children. Side effects: reads and writes books on the phone, talks to the server.
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

  /** Replaces the given books in the in-memory list and updates the screens. */
  const applyBooks = useCallback((changed) => {
    const byId = new Map(booksRef.current.map((book) => [book.id, book]));
    changed.forEach((book) => byId.set(book.id, book));
    booksRef.current = [...byId.values()];
    setAllBooks(booksRef.current);
  }, []);

  /**
   * Runs a sync. If one is already underway, another follows it, so an edit made during
   * a sync isn't left waiting. A failure just updates the status: the books are safe on
   * the phone and go up on a later try.
   */
  const syncNow = useCallback(async () => {
    if (!userId) return;
    if (running.current) { again.current = true; return; }
    running.current = true;
    setSync((s) => ({ ...s, state: 'syncing', message: null }));
    try {
      const { rejected } = await runSync({
        getBooks: async () => booksRef.current,
        putBooks: async (books) => { applyBooks(books); await store.saveBooks(userId, books); },
        getCursor: () => store.loadCursor(userId),
        setCursor: (cursor) => store.saveCursor(userId, cursor),
        getEpoch: () => store.loadEpoch(userId),
        setEpoch: (epoch) => store.saveEpoch(userId, epoch),
        post: (body) => api.request('POST', '/api/sync', body),
      });
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
  }, [userId, applyBooks]);

  /** Schedules a sync soon, restarting the wait if another edit arrives first. */
  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(syncNow, SYNC_DELAY_MS);
  }, [syncNow]);

  // Loads this account's books when someone signs in, then syncs. If the account changes
  // while loading, `cancelled` stops one person's books appearing under another's name.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    booksRef.current = [];
    setAllBooks([]);
    if (!userId) return undefined;
    store.loadBooks(userId).then((books) => {
      if (cancelled) return;
      booksRef.current = books;
      setAllBooks(books);
      setReady(true);
      syncNow();
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
   * In: form values, with `id` when editing. Out: the saved book.
   * Side effects: saves on the phone straight away, and schedules a sync.
   */
  const saveBook = useCallback(async (values) => {
    const existing = values.id ? booksRef.current.find((book) => book.id === values.id) : null;
    const book = {
      id: values.id || randomUUID(),
      title: values.title.trim(),
      authors: cleanNames(values.authors),
      categories: cleanNames(values.categories),
      status: values.status,
      rating: values.rating ?? null,
      readDate: values.readDate ?? null,
      notes: values.notes || '',
      updatedAt: nextEditTime(existing?.updatedAt),
      deleted: false,
      dirty: true,
    };
    applyBooks([book]);
    await store.saveBooks(userId, [book]);
    scheduleSync();
    return book;
  }, [userId, applyBooks, scheduleSync]);

  /**
   * Deletes a book. It stays on the phone as an emptied marker until the server has heard,
   * so other devices learn it's gone.
   * In: the book's id. Side effects: as saveBook.
   */
  const deleteBook = useCallback(async (id) => {
    const existing = booksRef.current.find((book) => book.id === id);
    if (!existing) return;
    const marker = {
      id, title: '', authors: [], categories: [], status: 'finished', rating: null, readDate: null,
      notes: '', updatedAt: nextEditTime(existing.updatedAt), deleted: true, dirty: true,
    };
    applyBooks([marker]);
    await store.saveBooks(userId, [marker]);
    scheduleSync();
  }, [userId, applyBooks, scheduleSync]);

  /**
   * Saves books from an import, already planned by lib/importBooks.js.
   * In: the books to save. Side effects: saves on the phone straight away, schedules a sync.
   */
  const importBooks = useCallback(async (books) => {
    applyBooks(books);
    await store.saveBooks(userId, books);
    scheduleSync();
  }, [userId, applyBooks, scheduleSync]);

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
