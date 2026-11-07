// lib/exportFile.web.js
// The browser's version of exportFile.js, chosen automatically by Expo when it builds the web version. A browser has no
// share menu, so an export downloads as a file, and importing uses the browser's file chooser. Nothing is written to a
// temporary folder, so there's nothing to clear afterward.

import { buildExport } from './exportBuild';
import { localDate } from './bookLogic';

// Far larger than any real library's export, and small enough not to exhaust the browser's memory.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Nothing to clear: a browser's downloads are the person's own files. */
export function clearLeftoverFiles() {}

/**
 * Downloads the library as a file.
 * In: the live books, and 'csv' or 'json'. Side effects: starts a download.
 * Works by making an invisible link to the file's contents in memory and clicking it, which is the standard way to
 * save a file from a page. The memory is released right after.
 */
export async function shareExport(books, format) {
  const { mimeType, text } = buildExport(books, format);
  const address = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement('a');
  link.href = address;
  link.download = `readeez-export-${localDate().replace(/-/g, '')}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(address);
}

/**
 * Lets the person choose a file, and reads it.
 * Out: the file's text, or null if they cancelled. Throws an Error with a message to show if it's too large.
 * lib/importBooks.js then checks everything in it, because the file comes from outside the app.
 */
export function pickExportFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      if (file.size > MAX_IMPORT_BYTES) { reject(new Error('That file is too large to import.')); return; }
      file.text().then(resolve, reject);
    });
    input.click();
  });
}
