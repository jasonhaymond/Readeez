// contexts/ThemeContext.js
// Supplies the current colours to every screen, and remembers the choice of mode
// (system/light/dark) and theme on this phone. A React "context" lets any component
// read shared values without passing them down through each layer. A "hook" (a
// function named useSomething) is how a component reads them.

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';
import { DEFAULT_THEME_ID, THEMES } from '../constants/themes';

const STORAGE_KEY = 'rz:appearance';
const ThemeContext = createContext(null);

/**
 * Wraps the app and provides the theme.
 * In: children (the rest of the app). Side effects: reads and saves the choice on the
 * phone, and sets the window's background to match, which avoids a white flash when
 * moving between screens in dark mode.
 */
export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme();
  const [mode, setMode] = useState('system');
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [ready, setReady] = useState(false);

  // Runs once on start. A damaged saved value falls back to the defaults.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.mode) setMode(parsed.mode);
          if (THEMES.some((t) => t.id === parsed.themeId)) setThemeId(parsed.themeId);
        } catch {
          // Defaults stand.
        }
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, themeId }));
  }, [mode, themeId, ready]);

  // useMemo recalculates only when an input changes, not on every screen redraw.
  const value = useMemo(() => {
    const dark = mode === 'system' ? systemScheme === 'dark' : mode === 'dark';
    const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];
    return {
      dark,
      mode,
      setMode,
      themeId,
      setThemeId,
      colors: dark ? theme.dark : theme.light,
      gradient: theme.kind === 'gradient' ? (dark ? theme.darkGradient : theme.lightGradient) : null,
    };
  }, [mode, themeId, systemScheme]);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(value.colors.bg).catch(() => {});
  }, [value.colors.bg]);

  return <ThemeContext.Provider value={value}>{ready ? children : null}</ThemeContext.Provider>;
}

/** Reads the theme inside a component. Out: { dark, mode, colors, gradient, ... }. */
export const useTheme = () => useContext(ThemeContext);
