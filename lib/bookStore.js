// lib/bookStore.js
// The library's copy on the phone, which is what lets the app work offline. Each book
// is its own AsyncStorage entry (AsyncStorage: Expo's simple on-device key/value store),
// because Android's store struggles with very large single values, and a whole library
// could exceed that as one entry. Every key includes the account id, so books from one
// family member's account are never shown to another signed in on the same phone. app.json turns
// off Android Auto Backup, so private notes stored here aren't copied to anyone's Google account.

import AsyncStorage from '@react-native-async-storage/async-storage';

const prefix = (userId) => `rz:${userId}:`;
const bookPrefix = (userId) => `${prefix(userId)}book:`;
const cursorKey = (userId) => `${prefix(userId)}cursor`;
const epochKey = (userId) => `${prefix(userId)}epoch`;

/**
 * Loads this account's books, including deleted markers still waiting to sync.
 * In: the account id. Out: an array of books.
 */
export async function loadBooks(userId) {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(bookPrefix(userId)));
  if (!keys.length) return [];
  const entries = await AsyncStorage.multiGet(keys);
  return entries.map(([, value]) => JSON.parse(value));
}

/**
 * Saves books. In: the account id and the books. Side effects: writes to the phone.
 */
export async function saveBooks(userId, books) {
  if (!books.length) return;
  await AsyncStorage.multiSet(books.map((book) => [`${bookPrefix(userId)}${book.id}`, JSON.stringify(book)]));
}

export const loadCursor = (userId) => AsyncStorage.getItem(cursorKey(userId));
export const saveCursor = (userId, cursor) => AsyncStorage.setItem(cursorKey(userId), cursor);
export const loadEpoch = (userId) => AsyncStorage.getItem(epochKey(userId));
export const saveEpoch = (userId, epoch) => AsyncStorage.setItem(epochKey(userId), epoch);

/**
 * Erases everything stored for one account. Called on an explicit sign-out, so private
 * notes don't stay on a phone that may change hands.
 * In: the account id. Side effects: deletes that account's data from the phone only.
 */
export async function clearAccount(userId) {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix(userId)));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}
