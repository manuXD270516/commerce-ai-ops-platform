import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isTransientConnectionError, waitForDatabase } from '../src/wait-for-db.js';

const { DATABASE_ADMIN_URL } = process.env;

describe('waitForDatabase', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('classifies refused, DNS and startup errors as transient, others as fatal', () => {
    for (const code of ['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', '57P03']) {
      expect(isTransientConnectionError({ code })).toBe(true);
    }
    expect(isTransientConnectionError({ code: '28P01' })).toBe(false); // bad password
    expect(isTransientConnectionError(new Error('x'))).toBe(false);
  });

  it('keeps retrying a refused address and gives up after the timeout', async () => {
    // A port that was just freed: connections are refused, as under a not-yet-synced policy.
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
    const logs: string[] = [];
    await expect(
      waitForDatabase(`postgres://u:p@127.0.0.1:${String(port)}/db`, {
        timeoutMs: 600,
        intervalMs: 100,
        log: (m) => logs.push(m),
      }),
    ).rejects.toThrow(/not reachable after \d+ attempts/);
    expect(logs.length).toBeGreaterThan(1);
  });

  it.skipIf(!DATABASE_ADMIN_URL)(
    'returns on the first attempt when the database is up',
    async () => {
      const result = await waitForDatabase(DATABASE_ADMIN_URL!);
      expect(result.attempts).toBe(1);
    },
  );

  it.skipIf(!DATABASE_ADMIN_URL)(
    'fails fast on a non-transient error such as a bad password',
    async () => {
      const url = new URL(DATABASE_ADMIN_URL!);
      url.password = 'definitely-wrong';
      const started = Date.now();
      await expect(waitForDatabase(url.toString(), { timeoutMs: 30_000 })).rejects.toMatchObject({
        code: '28P01',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );
});
