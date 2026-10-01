import { api, idempotencyKey, mutation } from '../../../lib/bff';

/**
 * One explicit click from the user: record the consent for this exact payload, then create the
 * ticket with it. The model never reaches this route.
 */
export function POST(request: Request): Promise<Response> {
  return mutation(request, async (session, body) => {
    const payload = {
      ...(typeof body.order_id === 'string' ? { order_id: body.order_id } : {}),
      category: body.category,
      summary: body.summary,
      ...(Array.isArray(body.evidence_refs) ? { evidence_refs: body.evidence_refs } : {}),
    };
    const consent = await api<{ id?: string }>(session, '/v1/consents', {
      method: 'POST',
      body: { command: 'create_support_ticket', payload },
    });
    if (!consent.ok || !consent.body.id) return consent;
    return api(session, '/v1/support-tickets', {
      method: 'POST',
      body: { ...payload, consent_id: consent.body.id },
      headers: idempotencyKey(request),
    });
  });
}
