// lib/bookSuggestions.js
// Online title and author suggestions for the book form, plus the setting that turns them off on this device. The
// server does the actual lookup (server/routes/lookup.js). Suggestions are a convenience, so any failure here simply
// shows none: being offline must never get in the way of adding a book.

import { useEffect, useState } from 'react';
import * as api from './api';
import { useDeviceSetting } from './deviceSettings';

// Waits for a pause in typing, so one title isn't a request per letter.
const TYPING_PAUSE_MS = 500;
const MIN_LETTERS = 3;
const NOTHING = { results: [], source: null };

/**
 * Reads and changes whether online suggestions are on, on this device.
 * Out: [on, setOn]. On by default: Settings and Help explain where the typed text goes.
 */
export const useSuggestionSetting = () => useDeviceSetting('rz:online-suggestions', true);

/**
 * Looks up suggestions for what's being typed.
 * In: 'title' or 'author', the typed text, and whether to look at all.
 * Out: { results, source }. Side effects: sends the text to the Readeez server after a pause in typing, which passes it
 * to the book catalogue. `stale` stops a slow answer for earlier text replacing the answer for what's typed now.
 */
export function useBookSuggestions(kind, text, active) {
  const [answer, setAnswer] = useState(NOTHING);
  useEffect(() => {
    const query = text.trim();
    if (!active || query.length < MIN_LETTERS) {
      setAnswer(NOTHING);
      return undefined;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const found = await api.request('POST', '/api/lookup', { kind, query });
        if (!stale) setAnswer(found);
      } catch {
        if (!stale) setAnswer(NOTHING);
      }
    }, TYPING_PAUSE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [kind, text, active]);
  return answer;
}
