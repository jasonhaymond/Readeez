// vitest.config.mjs
// Settings for the server's test suite. Tests hit a real Postgres in a throwaway Docker container
// (test/globalSetup.js), because a mocked database could pass while the actual SQL is broken. The files run one
// at a time, since they share that one database and empty it between tests.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/globalSetup.js'],
    setupFiles: ['./test/setupEnv.js'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
