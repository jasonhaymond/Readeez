// lib/exportBuild.js
// Builds the text of an export file, for both the phone's share menu (exportFile.js) and the browser's download
// (exportFile.web.js). The formats themselves live in server/exportFormat.js, which the server's Nextcloud exports also use.

import { toCsv, toJson } from '../server/exportFormat';
import appConfig from '../app.json';

/**
 * Builds an export.
 * In: the live books, and 'csv' or 'json'. Out: { mimeType, text }.
 */
export function buildExport(books, format) {
  if (format === 'csv') return { mimeType: 'text/csv', text: toCsv(books) };
  return { mimeType: 'application/json', text: toJson(books, appConfig.expo.version, new Date().toISOString()) };
}
