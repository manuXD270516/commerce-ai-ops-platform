import pg from 'pg';

/** Errors that mean "not reachable yet" (startup, DNS, network policy propagation), not "wrong". */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P03', // cannot_connect_now: the server is starting up
]);

export interface WaitForDatabaseOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
}

export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

/**
 * Blocks until a connection to `url` succeeds. One-shot jobs (the migration job) start as soon
 * as their pod does; on Kubernetes the database may be "ready" before this pod's address is
 * admitted by the network policy, so the first connections can be refused. Retrying in the same
 * process keeps the same pod address until the policy catches up, which a Job restart (new pod,
 * new address) would not. Authentication and other non-transient errors fail immediately.
 */
export async function waitForDatabase(
  url: string,
  { timeoutMs = 120_000, intervalMs = 2_000, log = () => undefined }: WaitForDatabaseOptions = {},
): Promise<{ attempts: number; waitedMs: number }> {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { attempts: attempt, waitedMs: Date.now() - started };
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;
      const waited = Date.now() - started;
      if (waited + intervalMs > timeoutMs) {
        throw new Error(
          `database not reachable after ${String(attempt)} attempts in ${String(waited)} ms: ${(error as Error).message}`,
          { cause: error },
        );
      }
      log(
        `database not reachable yet (${String((error as { code?: string }).code)}), attempt ${String(attempt)}; retrying`,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
