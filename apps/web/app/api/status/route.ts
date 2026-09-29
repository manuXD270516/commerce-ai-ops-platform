import { checkApiStatus } from '../../../lib/api-status';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return checkApiStatus(request, {
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:3001',
  });
}
