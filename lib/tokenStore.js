// lib/tokenStore.js
// Keeps the sign-in token on the phone, using Android's encrypted Keystore through
// expo-secure-store, so other apps can't read it. Ordinary storage wouldn't protect it.
//
// The Android app always uses the secure path. The web branch exists only for the
// developer's browser preview, which has no secure store and isn't a shipped product.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const KEY = 'readeez-token';
const isWeb = Platform.OS === 'web';

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
