// test/setupEnv.js
// Runs in each test worker before any test file loads, copying the settings written
// by globalSetup.js into the environment so db.js connects to the test database.

const fs = require('fs');
const path = require('path');

Object.assign(process.env, JSON.parse(fs.readFileSync(path.join(__dirname, '.env.test.json'), 'utf8')));
