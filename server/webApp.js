// webApp.js
// Serves the browser version of Readeez: the files `expo export` builds from the same code as the Android app. The
// Dockerfile puts them in the folder WEB_ROOT names. With no folder set, as in the test suite's API tests and a plain
// API development server, this does nothing, and unknown addresses keep answering 404.
//
// Security-relevant: these responses replace the API's "allow nothing" content policy with one that allows only this
// site's own scripts, which is the main defence if a book title ever carried a script into the page.

const fs = require('fs');
const path = require('path');
const express = require('express');

// What a browser may load for these pages. Scripts, fonts, images and connections come only from this site, so an
// injected script couldn't load more code or send data elsewhere. Inline styles are allowed because the screen-drawing
// library (react-native-web) creates its styles while running. Styles can't run code. data: and blob: images cover
// icons built into the bundle. No framing, so another site can't overlay this one to trick someone into tapping it.
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Builds the middleware that serves the web app.
 * In: the folder holding the built files, or nothing. Out: an Express router, or null when there's no folder.
 * Throws if a folder is set but holds no built app, because a server that quietly lost its web app is worse than one
 * that says so at startup.
 */
function createWebRouter(root) {
  if (!root) return null;
  const folder = path.resolve(root);
  const page = path.join(folder, 'index.html');
  if (!fs.existsSync(page)) throw new Error(`WEB_ROOT is set, but ${page} doesn't exist.`);

  const router = express.Router();
  router.use((req, res, next) => {
    // /api answers keep their own policy, and fall through to the JSON 404 when unknown.
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.set('Content-Security-Policy', CONTENT_POLICY);
    return next();
  });

  // express.static refuses paths that climb out of the folder, and dotfiles are refused too. Files under _expo/static
  // and assets have a fingerprint of their contents in their name, so a new version gets new names, and browsers can
  // keep these for a long time. Everything else keeps the app-wide no-store, so an update reaches people at once.
  router.use(express.static(folder, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      const relative = path.relative(folder, filePath).split(path.sep).join('/');
      if (relative.startsWith('_expo/static/') || relative.startsWith('assets/')) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // Any other page address gets the app itself. Matches anything that doesn't start with /api, such as / or /stats.
  router.get(/^\/(?!api(?:\/|$)).*/, (req, res) => res.sendFile(page));
  return router;
}

module.exports = { createWebRouter };
