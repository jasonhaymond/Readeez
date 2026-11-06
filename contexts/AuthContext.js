// contexts/AuthContext.js
// Tracks who's signed in. On start it restores the saved session, and keeps the person
// signed in even if the server can't be reached, since the app works offline. A 401 from
// the server means the session has really ended, and returns them to the sign-in screen.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from '../lib/api';
import { clearToken, loadToken, saveToken } from '../lib/tokenStore';
import { clearAccount } from '../lib/bookStore';
import { clearLeftoverFiles } from '../lib/exportFile';
import { seal, unseal } from '../lib/localCrypto';

const USER_KEY = 'rz:user';
const AuthContext = createContext(null);

/**
 * Wraps the app and provides the signed-in user and sign-in actions.
 * In: children. Side effects: reads and writes the token and user details on the phone.
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
    await clearToken();
    await AsyncStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  // Restores any saved session once at start, then tells the network layer what to do
  // when the server says the session is no longer valid.
  useEffect(() => {
    api.setUnauthorizedHandler(endSession);
    clearLeftoverFiles();
    (async () => {
      await api.loadServerUrl();
      const [token, saved] = await Promise.all([loadToken(), AsyncStorage.getItem(USER_KEY)]);
      if (token && saved) {
        api.setAuthToken(token);
        // The saved details are encrypted. If they can't be read, the catch below leads to the sign-in screen.
        setUser(await unseal(USER_KEY, saved));
        // Picks up changes made elsewhere, such as a reset notice. Offline, the saved copy stands.
        api.request('GET', '/api/auth/me').then(async ({ user: fresh }) => {
          await AsyncStorage.setItem(USER_KEY, await seal(USER_KEY, fresh));
          setUser(fresh);
        }).catch(() => {});
      }
      setLoading(false);
    })().catch(() => setLoading(false));
  }, [endSession]);

  /**
   * Stores a new session from any route that signs someone in.
   * In: the server's { token, user }. Side effects: saves both, and opens the app.
   */
  const startSession = useCallback(async ({ token, user: signedIn }) => {
    api.setAuthToken(token);
    await saveToken(token);
    await AsyncStorage.setItem(USER_KEY, await seal(USER_KEY, signedIn));
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
     */
    signOut: async () => {
      await api.request('POST', '/api/auth/logout').catch(() => {});
      if (user) await clearAccount(user.id);
      clearLeftoverFiles();
      await endSession();
    },
  }), [user, loading, startSession, endSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Reads the sign-in state inside a component. */
export const useAuth = () => useContext(AuthContext);
