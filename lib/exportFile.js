// lib/exportFile.js
// The share-sheet export: writes the library to a file in the phone's temporary folder
// and opens Android's share menu, so the person chooses where it goes. Works offline,
// since it uses the phone's own copy. Also picks an export file to import, through Android's
// file picker, which includes Nextcloud's app. A browser uses exportFile.web.js instead.
//
// Both leave a plain-text copy of the library in the app's temporary folder for a while, outside the on-device
// encryption. Each removes its copy when finished, and clearLeftoverFiles catches any left by the app being stopped.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { buildExport } from './exportBuild';
import { localDate } from './bookLogic';

// Far larger than any real library's export, and small enough not to exhaust a phone's memory.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
// The folder inside the temporary folder where Android's file picker module puts its copies.
const PICKER_FOLDER = 'DocumentPicker';

/**
 * Deletes a temporary file, without letting a failure hide the real result of whatever just used it. A file that
 * won't delete stays in this app's private folder until clearLeftoverFiles or Android removes it.
 * In: the file. Side effects: deletes it if it's there.
 */
function removeQuietly(file) {
  try {
    if (file.exists) file.delete();
  } catch (err) {
    console.warn(`Could not delete a temporary file: ${err.message}`);
  }
}

/**
 * Removes plain-text copies of the library left in the temporary folder. Sharing leaves the app in the background
 * while the other app is open, and Android can stop it there, so its own cleanup may never run.
 * Called when the app starts and at sign-out, when no share or import can be underway.
 * Side effects: deletes old exports and the file picker's copies, and nothing else. Each is tried on its own, so one
 * that won't delete can't leave the others behind. Never throws, as this mustn't stop the app opening.
 */
export function clearLeftoverFiles() {
  let items = [];
  try {
    items = Paths.cache.list();
  } catch (err) {
    console.warn(`Could not list temporary files: ${err.message}`);
  }
  items
    .filter((item) => item.name.startsWith('readeez-export-') || item.name === PICKER_FOLDER)
    .forEach((item) => {
      try {
        item.delete();
      } catch (err) {
        console.warn(`Could not clear a temporary file: ${err.message}`);
      }
    });
}

/**
 * Exports and shares the library.
 * In: the live books, and 'csv' or 'json'. Out: nothing; throws if sharing isn't
 * available or the file can't be written.
 * Side effects: writes a temporary file, opens the share menu, and removes the file afterward, so a
 * plain-text copy of the library doesn't stay behind on the phone.
 */
export async function shareExport(books, format) {
  const { mimeType, text } = buildExport(books, format);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn\'t available on this device.');
  const file = new File(Paths.cache, `readeez-export-${localDate().replace(/-/g, '')}.${format}`);
  try {
    file.create({ overwrite: true });
    file.write(text);
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: 'Export your library' });
  } finally {
    removeQuietly(file);
  }
}

/**
 * Lets the person pick a file, and reads it.
 * Out: the file's text, or null if they cancelled. Throws an Error with a message to show if it's too
 * large. The picker copies the file into the temporary folder, and that copy is deleted once read, so a plain-text
 * copy of the library doesn't stay behind.
 */
export async function pickExportFile() {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', 'application/octet-stream'], copyToCacheDirectory: true });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const copy = new File(asset.uri);
  try {
    if (asset.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import.');
    return await copy.text();
  } finally {
    removeQuietly(copy);
  }
}
