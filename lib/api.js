// lib/api.js
// How the app talks to the Readeez server. All network requests go through request()
// here, which attaches the sign-in token and turns failures into errors with messages
// fit to show. The server address comes from the app build (EXPO_PUBLIC_API_URL), and
// can be changed on the sign-in screen.

import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_KEY = 'rz:server';
const TIMEOUT_MS = 20000;

// Expo fills this in when the app is built. It isn't in the source code, so the public
// repo doesn't name any private server.
const BUILT_IN_SERVER = process.env.EXPO_PUBLIC_API_URL || '';

let serverUrl = BUILT_IN_SERVER;
let authToken = null;
let onUnauthorized = null;

/**
 * An error from a request. `status` is the HTTP code, or 0 if the server couldn't be
 * reached at all, which is what the app treats as "offline".
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Loads a saved server address over the built-in one, if there is one. */
export async function loadServerUrl() {
  const saved = await AsyncStorage.getItem(SERVER_KEY);
  if (saved) serverUrl = saved;
  return serverUrl;
}

/**
 * Saves the server address typed on the sign-in screen, with any trailing slash removed.
 * In: address text. Side effects: later requests go to that address.
 */
export async function saveServerUrl(url) {
  serverUrl = url.trim().replace(/\/+$/, '');
  await AsyncStorage.setItem(SERVER_KEY, serverUrl);
}

export const getServerUrl = () => serverUrl;
export const setAuthToken = (token) => { authToken = token; };
export const setUnauthorizedHandler = (handler) => { onUnauthorized = handler; };

/**
 * Sends one request to the server.
 * In: method, a path such as '/api/sync', and optionally a body to send as JSON.
 * Out: the parsed answer. Throws an ApiError on any failure. A 401 on a signed-in
 * request also runs the handler AuthContext registered, which returns to sign-in.
 */
export async function request(method, path, body) {
  if (!serverUrl) throw new ApiError('Enter your server address first.', 0);
  let res;
  // Gives up after a while, so a dead connection can't hang the app. Uses a timer rather
  // than AbortSignal.timeout, which React Native doesn't reliably provide.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('Couldn\'t reach the server. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timeout);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON, e.g. a reverse proxy's error page. The status below still applies.
  }
  if (!res.ok) {
    if (res.status === 401 && authToken && onUnauthorized && !path.startsWith('/api/auth/password')) onUnauthorized();
    throw new ApiError((data && data.error) || 'The server had a problem. Please try again.', res.status);
  }
  return data;
}
