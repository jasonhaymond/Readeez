// lib/deviceSession.web.js
// The browser's version of deviceSession.js. A browser holds its session in a cookie that page scripts can't read (see
// server/auth.js), so there's nothing to save here, and nothing about the person is stored in the browser. A reload
// asks the server who's signed in.

import * as api from './api';

/**
 * Asks the server who this browser is signed in as.
 * Out: { token: true, user }, where true marks a session held by the cookie, or null if nobody is signed in or the
 * server can't be reached. The browser version doesn't work offline, so it shows the sign-in screen in that case.
 */
export async function restoreSession() {
  try {
    const { user } = await api.request('GET', '/api/auth/me');
    return { token: true, user };
  } catch {
    return null;
  }
}

/** Nothing to save: the server has set the cookie by the time this is called. */
export async function saveSession() {}

/** Nothing to save: the person's details stay in memory. */
export async function saveUser() {}

/** Nothing to clear: signing out clears the cookie on the server's instruction. */
export async function clearSession() {}
