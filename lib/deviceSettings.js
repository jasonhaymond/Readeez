// lib/deviceSettings.js
// Simple on/off choices remembered on this device, such as whether to offer online suggestions. They hold no private
// data, so they use ordinary storage rather than the encrypted book storage. Each device keeps its own.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Reads and changes one choice. A React "hook" (a function named useSomething) gives a component a value that redraws
 * it when changed.
 * In: the storage name, and the value to use when nothing has been saved.
 * Out: [on, setOn]. A failure to read leaves the default, and a failure to save lasts until the next change.
 */
export function useDeviceSetting(key, defaultOn) {
  const [on, setOnState] = useState(defaultOn);
  useEffect(() => {
    AsyncStorage.getItem(key).then((saved) => {
      if (saved) setOnState(saved === 'on');
    }).catch(() => {});
  }, [key]);
  const setOn = (value) => {
    setOnState(value);
    AsyncStorage.setItem(key, value ? 'on' : 'off').catch(() => {});
  };
  return [on, setOn];
}
