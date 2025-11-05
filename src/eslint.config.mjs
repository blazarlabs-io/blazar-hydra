// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/build/**', 'build/**', './build/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'prefer-const': 'error',
      'no-sparse-arrays': 'off',
      'no-empty-pattern': 'off',
      'no-case-declarations': 'off',
      'no-async-promise-executor': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-namespace': 'off',
    },
  }
);
