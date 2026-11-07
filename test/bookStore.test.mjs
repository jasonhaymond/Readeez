// test/bookStore.test.mjs
// Tests what the phone's book storage does with books it can't decrypt. Storage and encryption are replaced with
// simple stand-ins, because both are Android features that don't exist here. "BAD" stands for a value that won't open.

import { beforeEach, expect, test, vi } from 'vitest';

const store = new Map();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: async () => [...store.keys()],
    multiGet: async (keys) => keys.map((key) => [key, store.get(key)]),
    multiSet: async (entries) => { entries.forEach(([key, value]) => store.set(key, value)); },
    multiRemove: async (keys) => { keys.forEach((key) => store.delete(key)); },
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => { store.set(key, value); },
    removeItem: async (key) => { store.delete(key); },
  },
}));

const key = vi.hoisted(() => ({ available: true }));

vi.mock('../lib/localCrypto', () => ({
  ensureKey: async () => {
    if (!key.available) throw new Error('Keystore unavailable');
  },
  seal: async (label, value) => JSON.stringify(value),
  unseal: async (label, stored) => {
    if (stored === 'BAD') throw new Error('will not open');
    return JSON.parse(stored);
  },
}));

const { clearAccount, eraseCount, loadBooks, saveBooks, saveCursor, saveEpoch } = await import('../lib/bookStore');

const CURSOR = 'rz:u1:cursor';
const GOOD = 'rz:u1:book:good';
const BROKEN = 'rz:u1:book:broken';

beforeEach(() => {
  key.available = true;
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

// A brief Keystore failure says nothing about the books. Treating it as damage would clear the sync position, throw away
// unsynced edits on the next download, and list every book as unreadable.
test('an unavailable key fails the load and changes nothing', async () => {
  key.available = false;
  await expect(loadBooks('u1')).rejects.toThrow('Keystore unavailable');
  expect(store.get(CURSOR)).toBe('42');
  expect(store.has('rz:u1:unreadable')).toBe(false);
});

// A phone can change hands, so a sync still running at sign-out mustn't put private notes back after the erase.
test('a sync that started before sign-out can write nothing afterward', async () => {
  const startedAt = eraseCount('u1');
  await clearAccount('u1');
  await saveBooks('u1', [{ id: 'late', notes: 'private' }], startedAt);
  await saveCursor('u1', '99', startedAt);
  await saveEpoch('u1', 'e', startedAt);
  expect([...store.keys()].filter((name) => name.startsWith('rz:u1:'))).toEqual([]);
});

// A sync timer can fire after the erase starts, and would hold the new count.
test('a sync that starts during sign-out can write nothing either', async () => {
  await clearAccount('u1');
  await saveBooks('u1', [{ id: 'late' }], eraseCount('u1'));
  expect([...store.keys()].filter((name) => name.startsWith('rz:u1:'))).toEqual([]);
});

// The old sync can still be running when the same person signs back in, and its stale writes must stay out.
test('after signing back in, new writes work and the old sync\'s still do not', async () => {
  const old = eraseCount('u1');
  await clearAccount('u1');
  await loadBooks('u1');
  await saveBooks('u1', [{ id: 'stale' }], old);
  expect(store.has('rz:u1:book:stale')).toBe(false);
  await saveBooks('u1', [{ id: 'fresh' }]);
  expect(store.has('rz:u1:book:fresh')).toBe(true);
});

// Signing out one person doesn't affect another's writes on the same phone.
test('another account can still be written', async () => {
  await clearAccount('u1');
  await saveBooks('u2', [{ id: 'other' }]);
  expect(store.has('rz:u2:book:other')).toBe(true);
});
