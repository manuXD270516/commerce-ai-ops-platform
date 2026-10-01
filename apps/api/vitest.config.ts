import { defineConfig } from 'vitest/config';

// Test files share one PostgreSQL and each runs migrate + seed, so they run one at a time.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
  },
});
