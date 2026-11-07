// lib/useRevealFocusedField.js
// Keeps the field being typed in visible above the on-screen keyboard on Android, by scrolling the form. Android draws
// the app behind the keyboard and doesn't scroll to the field by itself, so a field low on a long form would sit hidden,
// and typing would go in unseen. A browser's keyboard events don't fire here, so this does nothing there.

import { useCallback, useEffect, useRef } from 'react';
import { Keyboard, TextInput } from 'react-native';

// Clear space to leave between the field and the keyboard.
const MARGIN = 24;
// Lets the form finish shrinking for the keyboard before measuring it.
const SETTLE_MS = 120;

/**
 * Gives a screen what it needs to keep the focused field visible. A "hook" (a function named useSomething) ties
 * behaviour to a component's life.
 * Out: { scrollRef, onScroll, reveal }. Pass scrollRef and onScroll to the screen's ScrollView, with
 * scrollEventThrottle set. Pass reveal as onFocus to any field, for moving between fields while the keyboard is already up.
 * Side effects: listens for the keyboard while the screen is open, and scrolls the form.
 */
export function useRevealFocusedField() {
  const scrollRef = useRef(null);
  const offset = useRef(0);
  // Where the keyboard's top edge is on screen, or null when it's down.
  const keyboardTop = useRef(null);
  const timer = useRef(null);

  /** Records how far the form has scrolled, since the correction below is added to it. */
  const onScroll = useCallback((event) => {
    offset.current = event.nativeEvent.contentOffset.y;
  }, []);

  /** Scrolls just far enough to lift the focused field above the keyboard, if it's covered. */
  const reveal = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Checked first, because a browser never reports a keyboard, and doesn't have the lookup on the next line.
      if (keyboardTop.current === null) return;
      const field = TextInput.State.currentlyFocusedInput();
      if (!field) return;
      field.measureInWindow((x, y, width, height) => {
        const covered = y + height + MARGIN - keyboardTop.current;
        if (covered > 0) scrollRef.current?.scrollTo({ y: offset.current + covered, animated: true });
      });
    }, SETTLE_MS);
  }, []);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      reveal();
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { keyboardTop.current = null; });
    return () => {
      shown.remove();
      hidden.remove();
      clearTimeout(timer.current);
    };
  }, [reveal]);

  return { scrollRef, onScroll, reveal };
}
