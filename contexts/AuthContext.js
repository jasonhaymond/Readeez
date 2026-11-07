// contexts/AuthContext.js
// Tracks who's signed in. On start it restores the saved session, and on a phone keeps the person
// signed in even if the server can't be reached, since the app works offline there. A 401 from
// the server means the session has really ended, and returns them to the sign-in screen.
// lib/deviceSession.js holds what differs between a phone and a browser.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import * as api from '../lib/api';
import { clearSession, restoreSession, saveSession, saveUser } from '../lib/deviceSession';
import { clearAccount } from '../lib/bookStore';
import { clearLeftoverFiles } from '../lib/exportFile';

const AuthContext = createContext(null);

/**
 * Wraps the app and provides the signed-in user and sign-in actions.
 * In: children. Side effects: reads and writes the session and user details on the device.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  /**
   * Ends the local session while keeping the phone's books. Used when the server rejects
   * the session, so unsynced books are still there when the same person signs back in.
   */
  const endSession = useCallback(async () => {
    api.setAuthToken(null);
    await clearSession();
    setUser(null);
  }, []);

  // Restores any saved session once at start, then tells the network layer what to do
  // when the server says the session is no longer valid.
  useEffect(() => {
    api.setUnauthorizedHandler(endSession);
    clearLeftoverFiles();
    (async () => {
      await api.loadServerUrl();
      // If the saved details can't be read, the catch below leads to the sign-in screen.
      const session = await restoreSession();
      if (session) {
        api.setAuthToken(session.token);
        setUser(session.user);
        // Picks up changes made elsewhere, such as a reset notice. Offline, the saved copy stands.
        api.request('GET', '/api/auth/me').then(async ({ user: fresh }) => {
          await saveUser(fresh);
          setUser(fresh);
        }).catch(() => {});
      }
      setLoading(false);
    })().catch(() => setLoading(false));
  }, [endSession]);

  /**
   * Stores a new session from any route that signs someone in.
   * In: the server's answer, { user } and on a phone { token }. A browser's token is in a cookie, so true marks it signed in.
   * Side effects: saves both, and opens the app.
   */
  const startSession = useCallback(async ({ token, user: signedIn }) => {
    api.setAuthToken(token ?? true);
    await saveSession(token, signedIn);
    setUser(signedIn);
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    /** Signs in with email and password. Throws an ApiError with a message to show. */
    signIn: async (email, password) => startSession(await api.request('POST', '/api/auth/login', { email, password })),
    /** Creates an account from an invite code and signs in. Throws an ApiError. */
    redeem: async (details) => startSession(await api.request('POST', '/api/auth/redeem', details)),
    /**
     * Signs out on purpose: ends the session on the server if it can be reached, then
     * erases this account's books and any leftover export files from the phone, since the person chose to leave.
     * Erases first, so a sync still running can't write anything back while the server answers.
     *
     * A browser's session cookie can't be read or removed by the page, so only the server can end it. If the server can't
     * be reached, this throws an ApiError and the person stays signed in. Showing the sign-in screen anyway would look
     * safe on a shared computer, while the next person to reload would be back in their library. A 401 means the
     * session has already ended, which is the wanted result. A phone erases its own token, so it can always finish.
     */
    signOut: async () => {
      if (Platform.OS === 'web') {
        try {
          await api.request('POST', '/api/auth/logout');
        } catch (err) {
          if (err.status !== 401) throw err;
        }
        if (user) await clearAccount(user.id);
        await endSession();
        return;
      }
      if (user) await clearAccount(user.id);
      clearLeftoverFiles();
      await api.request('POST', '/api/auth/logout').catch(() => {});
      await endSession();
    },
  }), [user, loading, startSession, endSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Reads the sign-in state inside a component. */
export const useAuth = () => useContext(AuthContext);
