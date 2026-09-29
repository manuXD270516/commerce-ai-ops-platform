import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@commerce/telemetry', '@commerce/contracts', 'pino'],
  turbopack: { root: join(import.meta.dirname, '..', '..') },
};

export default nextConfig;
