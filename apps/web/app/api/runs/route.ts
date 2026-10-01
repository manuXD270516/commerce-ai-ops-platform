import { api, mutation } from '../../../lib/bff';

export function POST(request: Request): Promise<Response> {
  return mutation(request, (session, body) =>
    api(session, '/v1/agent-runs', {
      method: 'POST',
      body: {
        message: body.message,
        ...(body.ui_context === undefined ? {} : { ui_context: body.ui_context }),
      },
    }),
  );
}
