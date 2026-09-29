import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const APP_PACKAGES = [
  '@commerce/api',
  '@commerce/web',
  '@commerce/worker',
  '@commerce/commerce-mcp-server',
];

/** Builds a no-restricted-imports rule; deep imports into another package's src are always banned. */
function restrictImports(names, patterns = []) {
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: names.map((name) => ({
          name,
          message: 'Violates package boundaries (design.md §6).',
        })),
        patterns: [
          { group: ['@commerce/*/src/*'], message: 'Import the package entry point, not its src.' },
          ...patterns,
        ],
      },
    ],
  };
}

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.next/**',
    '**/node_modules/**',
    '**/src/generated/**',
    '**/next-env.d.ts',
    'coverage/**',
    'evals/reports/**',
    '.smoke/**',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    settings: { next: { rootDir: 'apps/web/' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'evals/**/*.ts'],
    rules: restrictImports([]),
  },
  {
    files: ['packages/**/*.ts'],
    rules: restrictImports(APP_PACKAGES, [
      { group: ['**/apps/**'], message: 'Packages must not import apps.' },
    ]),
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: restrictImports(
      [...APP_PACKAGES, '@commerce/domain', '@commerce/ai', '@commerce/telemetry'],
      [{ group: ['**/apps/**'], message: 'contracts is a leaf package.' }],
    ),
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: restrictImports(
      [...APP_PACKAGES, '@commerce/ai', 'next', 'react', 'bullmq'],
      [
        { group: ['**/apps/**'], message: 'Packages must not import apps.' },
        {
          group: ['@nestjs/*', 'next/*', '@langchain/*'],
          message: 'domain stays framework- and model-agnostic.',
        },
      ],
    ),
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      // NestJS modules, controllers and DI tokens rely on decorated classes.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
