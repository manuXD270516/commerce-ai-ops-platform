import { api, mutation } from '../../../../../lib/bff';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return mutation(request, (session, body) =>
    api(session, `/v1/approvals/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      body: {
        decision: body.decision,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      },
    }),
  );
}
