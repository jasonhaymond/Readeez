// lib/tokenStore.js
// Keeps the sign-in token and the local data key on the phone, encrypted with a key in Android's Keystore
// by expo-secure-store, so other apps can't read them. Ordinary storage wouldn't protect them. Only phone code uses
// this file: a browser's session is a cookie its scripts can't read (see deviceSession.web.js).

import * as SecureStore from 'expo-secure-store';

const KEY = 'readeez-token';
// The key that encrypts books on this phone (see localCrypto.js).
const DATA_KEY = 'readeez-data-key';

/** Returns the saved data key, or null. */
export async function loadDataKey() {
  return SecureStore.getItemAsync(DATA_KEY);
}

/** Saves the data key. */
export async function saveDataKey(value) {
  await SecureStore.setItemAsync(DATA_KEY, value);
}

/** Returns the saved token, or null. */
export async function loadToken() {
  return SecureStore.getItemAsync(KEY);
}

/** Saves the token. */
export async function saveToken(token) {
  await SecureStore.setItemAsync(KEY, token);
}

/** Forgets the token. */
export async function clearToken() {
  await SecureStore.deleteItemAsync(KEY);
}
