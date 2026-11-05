// lib/tokenStore.js
// Keeps the sign-in token and the local data key on the phone, encrypted with a key in Android's Keystore
// by expo-secure-store, so other apps can't read them. Ordinary storage wouldn't protect them.
//
// The Android app always uses the secure path. The web branch exists only for the
// developer's browser preview, which has no secure store and isn't a shipped product.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const KEY = 'readeez-token';
// The key that encrypts books on this phone (see localCrypto.js).
const DATA_KEY = 'readeez-data-key';
const isWeb = Platform.OS === 'web';

/** Returns the saved data key, or null. */
export async function loadDataKey() {
  if (isWeb) return globalThis.sessionStorage?.getItem(DATA_KEY) ?? null;
  return SecureStore.getItemAsync(DATA_KEY);
}

/** Saves the data key. */
export async function saveDataKey(value) {
  if (isWeb) { globalThis.sessionStorage?.setItem(DATA_KEY, value); return; }
  await SecureStore.setItemAsync(DATA_KEY, value);
}

/** Returns the saved token, or null. */
export async function loadToken() {
  if (isWeb) return globalThis.sessionStorage?.getItem(KEY) ?? null;
  return SecureStore.getItemAsync(KEY);
}

/** Saves the token. */
export async function saveToken(token) {
  if (isWeb) { globalThis.sessionStorage?.setItem(KEY, token); return; }
  await SecureStore.setItemAsync(KEY, token);
}

/** Forgets the token. */
export async function clearToken() {
  if (isWeb) { globalThis.sessionStorage?.removeItem(KEY); return; }
  await SecureStore.deleteItemAsync(KEY);
}
