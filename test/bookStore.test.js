// test/bookStore.test.js
// Tests what the phone's book storage does with books it can't decrypt. Storage and encryption are replaced with
// simple stand-ins, because both are Android features that don't exist here. "BAD" stands for a value that won't open.

import { beforeEach, expect, test, vi } from 'vitest';

const store = new Map();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...store.keys()],
    multiGet: async (keys) => keys.map((key) => [key, store.get(key)]),
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => { store.set(key, value); },
    removeItem: async (key) => { store.delete(key); },
  },
}));

vi.mock('../lib/localCrypto', () => ({
  seal: async (label, value) => JSON.stringify(value),
  unseal: async (label, stored) => {
    if (stored === 'BAD') throw new Error('will not open');
    return JSON.parse(stored);
  },
}));

const { loadBooks } = await import('../lib/bookStore');

const CURSOR = 'rz:u1:cursor';
const GOOD = 'rz:u1:book:good';
const BROKEN = 'rz:u1:book:broken';

beforeEach(() => {
  store.clear();
  store.set(GOOD, JSON.stringify({ id: 'good' }));
  store.set(CURSOR, '42');
});

// A newly unreadable book must trigger a full download, or the person would be missing it with no way to get it back.
test('a newly unreadable book clears the sync position', async () => {
  store.set(BROKEN, 'BAD');
  expect(await loadBooks('u1')).toEqual([{ id: 'good' }]);
  expect(store.has(CURSOR)).toBe(false);
});

// Data safety: the unreadable copy is kept, because deleting it would destroy an edit if the fault turned out to be brief.
test('an unreadable book is kept in storage', async () => {
  store.set(BROKEN, 'BAD');
  await loadBooks('u1');
  expect(store.get(BROKEN)).toBe('BAD');
});

// A book the server never received stays unreadable forever. It mustn't re-download the library at every launch.
test('the same unreadable book does not clear the position again', async () => {
  store.set(BROKEN, 'BAD');
  await loadBooks('u1');
  store.set(CURSOR, '43');
  await loadBooks('u1');
  expect(store.get(CURSOR)).toBe('43');
});

// A second book failing later is new, so it still gets its download.
test('another book becoming unreadable clears the position', async () => {
  store.set(BROKEN, 'BAD');
  await loadBooks('u1');
  store.set(CURSOR, '43');
  store.set('rz:u1:book:other', 'BAD');
  await loadBooks('u1');
  expect(store.has(CURSOR)).toBe(false);
});

// A book that recovers and fails again counts as new, so it isn't left missing.
test('a book failing again after recovering clears the position', async () => {
  store.set(BROKEN, 'BAD');
  await loadBooks('u1');
  store.set(BROKEN, JSON.stringify({ id: 'broken' }));
  await loadBooks('u1');
  store.set(CURSOR, '43');
  store.set(BROKEN, 'BAD');
  await loadBooks('u1');
  expect(store.has(CURSOR)).toBe(false);
});

// The normal case touches nothing.
test('readable books leave the position alone', async () => {
  expect(await loadBooks('u1')).toEqual([{ id: 'good' }]);
  expect(store.get(CURSOR)).toBe('42');
});
