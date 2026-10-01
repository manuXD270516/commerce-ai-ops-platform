import { api, mutation } from '../../../../../lib/bff';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return mutation(request, (session) =>
    api(session, `/v1/agent-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  );
}
