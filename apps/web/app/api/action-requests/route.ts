import { api, idempotencyKey, mutation } from '../../../lib/bff';

/** The user's explicit confirmation of a proposed cancellation request (no execution here). */
export function POST(request: Request): Promise<Response> {
  return mutation(request, (session, body) =>
    api(session, '/v1/action-requests', {
      method: 'POST',
      body: {
        order_id: body.order_id,
        reason_code: body.reason_code,
        expected_version: body.expected_version,
        ...(body.run_id === undefined ? {} : { run_id: body.run_id }),
      },
      headers: idempotencyKey(request),
    }),
  );
}
