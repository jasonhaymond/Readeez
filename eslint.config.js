// eslint.config.js
// Settings for ESLint, a tool that reads code looking for problems. Here it runs only the
// security rules of eslint-plugin-security, as part of the security gate (scripts/security-check.sh).
// Style isn't checked. Weakening or ignoring rules here needs the developer's specific approval.

const security = require('eslint-plugin-security');

module.exports = [
  // Installed packages and generated folders aren't this project's code.
  { ignores: ['**/node_modules/**', '.expo/**', 'dist/**', 'dist-android/**', 'android/**', 'ios/**'] },
  security.configs.recommended,
  {
    // App code uses modern import syntax and JSX (HTML-like markup inside JavaScript).
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    // Server code, tests and logic modules use Node's older require() syntax.
    files: ['server/**/*.js', 'lib/bookLogic.js', 'lib/syncEngine.js', 'lib/importBooks.js', 'constants/themes.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
