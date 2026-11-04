// test/globalTeardown.js
// Runs once after all tests: removes the throwaway database and its settings file.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Removes what globalSetup.js created. A container already gone is fine. */
module.exports = async function globalTeardown() {
  try {
    execSync('docker rm -f readeez-test-pg', { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
  fs.rmSync(path.join(__dirname, '.env.test.json'), { force: true });
};
