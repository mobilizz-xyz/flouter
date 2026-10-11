import globals from 'globals';

export default [
  { ignores: ['site/vendor/', 'dist/', 'build/'] },
  {
    files: ['site/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, __VERSION__: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-empty': 'error' },
  },
  {
    files: ['tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
];
