import { createServer, type Server } from 'node:http';
import type { DependencyCheck, HealthReport } from '@commerce/contracts';

export interface HealthServerOptions {
  readonly service: HealthReport['service'];
  readonly version: string;
  readonly readiness: () => Promise<DependencyCheck[]>;
}

/** Minimal liveness/readiness endpoint for processes without a public HTTP surface. */
export function createHealthServer(options: HealthServerOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/readyz')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not_found"}');
      return;
    }
    const checksPromise = path === '/readyz' ? options.readiness() : Promise.resolve([]);
    void checksPromise.then((checks) => {
      const ready = checks.every((c) => c.status === 'up');
      const body: HealthReport = {
        status: ready ? 'ok' : 'unavailable',
        service: options.service,
        version: options.version,
        observed_at: new Date().toISOString(),
        checks,
      };
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
}
