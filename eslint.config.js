import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.ts', '*.config.js', 'vitest.workspace.ts'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        process: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-undef': 'off',
    },
  },
  {
    // v2.4: parser-purity guard. Manifest parsers must stay free of network
    // primitives so BOM resolution stays in the tool layer (`bom_resolver.ts`).
    // ESLint blocks the import; `tests/unit/parser_purity.test.ts` is the
    // belt-and-suspenders substring scan that runs at test time.
    files: ['src/adapters/manifests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: 'Manifest parsers must not perform network I/O. Move BOM/network resolution into a service under src/services/.' },
            { name: 'node:https', message: 'Manifest parsers must not perform network I/O. Move BOM/network resolution into a service under src/services/.' },
            { name: 'http', message: 'Manifest parsers must not perform network I/O.' },
            { name: 'https', message: 'Manifest parsers must not perform network I/O.' },
            { name: 'undici', message: 'Manifest parsers must not perform network I/O.' },
            { name: 'node-fetch', message: 'Manifest parsers must not perform network I/O.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Manifest parsers must not call fetch. Move network calls into src/services/.' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        process: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
];
