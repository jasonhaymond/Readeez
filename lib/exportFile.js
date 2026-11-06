// lib/exportFile.js
// The share-sheet export: writes the library to a file in the phone's temporary folder
// and opens Android's share menu, so the person chooses where it goes. Works offline,
// since it uses the phone's own copy. The formats are shared with the server. Also picks an
// export file to import, through Android's file picker, which includes Nextcloud's app.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { toCsv, toJson } from '../server/exportFormat';
import { localDate } from './bookLogic';
import appConfig from '../app.json';

// Far larger than any real library's export, and small enough not to exhaust a phone's memory.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const FORMATS = {
  csv: { mimeType: 'text/csv', build: (books) => toCsv(books) },
  json: { mimeType: 'application/json', build: (books) => toJson(books, appConfig.expo.version, new Date().toISOString()) },
};

/**
 * Exports and shares the library.
 * In: the live books, and 'csv' or 'json'. Out: nothing; throws if sharing isn't
 * available or the file can't be written.
 * Side effects: writes a temporary file, opens the share menu, and removes the file afterward, so a
 * plain-text copy of the library doesn't stay behind on the phone.
 */
export async function shareExport(books, format) {
  const { mimeType, build } = format === 'csv' ? FORMATS.csv : FORMATS.json;
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn\'t available on this device.');
  const file = new File(Paths.cache, `readeez-export-${localDate().replace(/-/g, '')}.${format}`);
  file.create({ overwrite: true });
  file.write(build(books));
  try {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: 'Export your library' });
  } finally {
    file.delete();
  }
}

/**
 * Lets the person pick a file, and reads it.
 * Out: the file's text, or null if they cancelled. Throws an Error with a message to show if it's too
 * large. The picker copies the file into the temporary folder, and that copy is deleted once read, so a plain-text
 * copy of the library doesn't stay behind. The web branch is only for the developer's browser preview.
 */
export async function pickExportFile() {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', 'application/octet-stream'], copyToCacheDirectory: true });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (asset.file) {
    if (asset.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import.');
    return asset.file.text();
  }
  const copy = new File(asset.uri);
  try {
    if (asset.size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import.');
    return await copy.text();
  } finally {
    // A copy that won't delete shouldn't fail an import that worked. It stays in this app's private temporary
    // folder, which Android clears when it needs space.
    try {
      copy.delete();
    } catch (err) {
      console.warn(`Could not delete the import copy: ${err.message}`);
    }
  }
}
