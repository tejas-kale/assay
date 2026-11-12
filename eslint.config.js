// The smell gate (docs/process/coding-standards.md). `npm run lint` fails on any warning; today's violations are
// suppressed in eslint-suppressions.json, which may only shrink.
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

const SIZE = { skipBlankLines: true, skipComments: true }

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'python/**', 'plugin/**', '.venv/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'max-lines-per-function': ['error', { max: 40, ...SIZE }],
      'max-lines': ['error', { max: 400, ...SIZE }],
      'max-params': ['error', 4],
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-identical-functions': 'error',
      // node:test's test() and describe() return promises the runner awaits itself.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }] },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    // An error, not the plugin's warning: only errors can go in the baseline, and any warning fails the check.
    rules: { ...reactHooks.configs.flat.recommended.rules, 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    // Build scripts and tests run git and the CLIs from PATH by design: the integration tests put their fakes first on
    // it. The app's own code (src/) keeps the rule.
    files: ['scripts/**/*.{ts,mjs}', 'tests/**/*.ts'],
    rules: { 'sonarjs/no-os-command-from-path': 'off' },
  },
  { files: ['**/*.{js,mjs,cjs}'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
)
