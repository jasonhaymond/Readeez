// lib/localCrypto.js
// Encrypts what the app keeps on the phone: books, notes, and the signed-in person's name and email. It uses
// AES-256-GCM, which also detects any tampering, from Expo's crypto module. The key is random, made on this
// phone, and held in Android's Keystore (see tokenStore.js), so the files alone can't be read, for example
// from a rooted phone's storage or a copy of the app's data.
//
// What this doesn't stop: someone who can run code as the unlocked app, such as on a fully compromised phone.
// There the app has to be able to read its own data. The key isn't backed up, so a lost key means re-downloading
// from the server (see bookStore.js).

import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { loadDataKey, saveDataKey } from './tokenStore';

const FORMAT = 'v1:';
// Remembered so the key is only fetched once, and so simultaneous first uses can't each make a different one.
let keyPromise = null;

/**
 * Gets this phone's key, making one the first time.
 * Out: the key. Side effects: stores a new key in the Keystore if there was none.
 */
function getKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const saved = await loadDataKey();
      if (saved) return AESEncryptionKey.import(saved, 'base64');
      const key = await AESEncryptionKey.generate(256);
      await saveDataKey(await key.encoded('base64'));
      return key;
    })();
    // A failure shouldn't be remembered forever, so the next use tries again.
    keyPromise.catch(() => { keyPromise = null; });
  }
  return keyPromise;
}

// The label is authenticated along with the data, so a stored value only opens under the name it was saved
// with. One person's book can't be moved into another person's storage and accepted as theirs.
const labelBytes = (label) => new TextEncoder().encode(label);

/**
 * Encrypts a value for storage.
 * In: the storage name it'll be saved under, and any JSON-friendly value. Out: text to store.
 */
export async function seal(label, value) {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await aesEncryptAsync(plaintext, await getKey(), { additionalData: labelBytes(label) });
  return `${FORMAT}${await sealed.combined('base64')}`;
}

/**
 * Reverses seal().
 * In: the storage name, and the stored text. Out: the value. Throws if the key is wrong, the data was altered,
 * or it was stored under another name.
 */
export async function unseal(label, stored) {
  if (typeof stored !== 'string' || !stored.startsWith(FORMAT)) throw new Error('Not encrypted data');
  const sealed = AESSealedData.fromCombined(stored.slice(FORMAT.length));
  const bytes = await aesDecryptAsync(sealed, await getKey(), { additionalData: labelBytes(label) });
  return JSON.parse(new TextDecoder().decode(bytes));
}
