// Minimal flat config: catch the bugs a test suite does not (undefined names,
// unused variables, loose equality), nothing stylistic. `npm run lint`.
import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
};

export default [
  { ignores: ['node_modules/**', 'data/**', 'public/vendor/**', 'netlify/**', '.netlify/**', 'coverage/**'] },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules,
  },
  {
    // The smoke test's page.evaluate callbacks run in the browser.
    files: ['test/ui/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules,
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules,
  },
  {
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules,
  },
];
