// vitest.config.mjs
// Settings for the app's logic tests, which need no phone or server. The server has its own suite and settings.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.js'],
    // A stray .only would quietly skip every other test, so it's an error.
    allowOnly: false,
  },
});
