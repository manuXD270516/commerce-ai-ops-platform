import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

/**
 * E2E by role against the real builds (`pnpm build` first) and the local Compose PostgreSQL.
 * Ports 3100-3102 avoid the dev servers. The API runs agent runs in-process (no worker needed).
 * Browser: an installed Edge/Chrome channel by default (no browser download); set PW_CHANNEL=
 * chromium after `pnpm exec playwright install chromium` on machines without one (e.g. CI).
 */
const API_PORT = 3101;
const WEB_PORT = 3100;
const DEGRADED_WEB_PORT = 3102;
const channel = process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: join(root, '.smoke', 'e2e', 'report.json') }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    ...(channel === 'chromium' ? {} : { channel }),
    trace: 'retain-on-failure',
  },
  outputDir: join(root, '.smoke', 'e2e', 'artifacts'),
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: join(root, 'apps', 'api'),
      url: `http://127.0.0.1:${String(API_PORT)}/healthz`,
      env: {
        ...process.env,
        API_PORT: String(API_PORT),
        RUN_EXECUTION: 'inline',
        LOG_LEVEL: 'warn',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start --port ${String(WEB_PORT)} --hostname 127.0.0.1`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${String(WEB_PORT)}/login`,
      env: { ...process.env, API_BASE_URL: `http://127.0.0.1:${String(API_PORT)}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Same console pointed at an API that is down: exercises the degraded state.
      command: `pnpm exec next start --port ${String(DEGRADED_WEB_PORT)} --hostname 127.0.0.1`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${String(DEGRADED_WEB_PORT)}/login`,
      env: { ...process.env, API_BASE_URL: 'http://127.0.0.1:3199' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

export const DEGRADED_URL = `http://127.0.0.1:${String(DEGRADED_WEB_PORT)}`;
