import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@commerce/telemetry', '@commerce/contracts', 'pino'],
  turbopack: { root: join(import.meta.dirname, '..', '..') },
  // Same baseline headers whatever edge is in front; HSTS stays with the TLS terminator.
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]),
};

export default nextConfig;
