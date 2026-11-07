// lib/deviceSession.js
// Keeps someone signed in on a phone between launches. The token goes in Android's Keystore (tokenStore.js) and their
// name and email are encrypted (localCrypto.js). A browser uses deviceSession.web.js instead: Expo picks a ".web.js"
// file over this one when it builds the web version, so none of this phone-only code reaches a browser.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearToken, loadToken, saveToken } from './tokenStore';
import { seal, unseal } from './localCrypto';

const USER_KEY = 'rz:user';

/**
 * Finds the saved session, if any.
 * Out: { token, user }, or null if nobody is signed in. Throws if the saved details can't be read, which AuthContext
 * treats as signed out. Works with no connection, because the app works offline.
 */
export async function restoreSession() {
  const [token, saved] = await Promise.all([loadToken(), AsyncStorage.getItem(USER_KEY)]);
  if (!token || !saved) return null;
  return { token, user: await unseal(USER_KEY, saved) };
}

/**
 * Saves a new session. In: the token and the user's details. Side effects: writes both to the phone.
 */
export async function saveSession(token, user) {
  await saveToken(token);
  await saveUser(user);
}

/** Saves newer details for the signed-in person. In: the user's details. */
export async function saveUser(user) {
  await AsyncStorage.setItem(USER_KEY, await seal(USER_KEY, user));
}

/** Forgets the session on this phone. The books stay until an explicit sign-out erases them. */
export async function clearSession() {
  await clearToken();
  await AsyncStorage.removeItem(USER_KEY);
}
