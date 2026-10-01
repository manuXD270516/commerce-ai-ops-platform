import { defineConfig } from 'vitest/config';

// Unit tests only; browser E2E lives in e2e/ and runs with Playwright (pnpm e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
