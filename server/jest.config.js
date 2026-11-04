// jest.config.js
// Settings for the server's test suite. Tests hit a real Postgres in a throwaway
// Docker container (test/globalSetup.js), because a mocked database could pass while
// the actual SQL is broken. `--runInBand` in package.json runs the files one at a
// time, since they share that one database and empty it between tests.

module.exports = {
  testEnvironment: 'node',
  globalSetup: './test/globalSetup.js',
  globalTeardown: './test/globalTeardown.js',
  setupFiles: ['./test/setupEnv.js'],
  testTimeout: 30000,
};
