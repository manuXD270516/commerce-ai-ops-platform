import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  POLICY_VERSION,
  createActionRequest,
  createDb,
  createPool,
  decideApproval,
  executeUpdateOrder,
  getActionRequest,
  listActionRequests,
  migrate,
  seedCommerceDomain,
  type ActorContext,
} from '../src/index.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
const runtimeUrl = process.env.DATABASE_URL;
const piiKey = process.env.PII_ENCRYPTION_KEY;
const enabled = Boolean(adminUrl && migratorUrl && runtimeUrl && piiKey);

const ACME = FIXTURES.tenants.acme;
const actor = (
  role: ActorContext['role'],
  subjectId: string,
  customerId?: string,
): ActorContext => ({
  tenantId: ACME,
  subjectId,
  role,
  policyVersion: POLICY_VERSION,
  ...(customerId ? { customerId } : {}),
});
const ana = actor('customer', FIXTURES.subjects.ana, FIXTURES.customers.ana);
const ben = actor('customer', FIXTURES.subjects.ben, FIXTURES.customers.ben);
const support = actor('support', FIXTURES.subjects.acmeSupport);
const approver = actor('approver', FIXTURES.subjects.acmeApprover);
const admin = actor('admin', FIXTURES.subjects.acmeAdmin);

describe.skipIf(!enabled)('human approval and the bounded cancellation (M8)', () => {
  const db = createDb(createPool(runtimeUrl!));
  const owner = new pg.Client({ connectionString: migratorUrl });

  /** A fresh CONFIRMED order for Ana, so each test owns its state. */
  async function confirmedOrder(): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
       VALUES ($1, $2, $3, 'CONFIRMED', 'USD', 2900, 0, 0, 2900)`,
      [ACME, id, FIXTURES.customers.ana],
    );
    return id;
  }
  const order = async (id: string) =>
    (
      await owner.query<{ status: string; version: number }>(
        'SELECT status, version FROM commerce.orders WHERE id = $1',
        [id],
      )
    ).rows[0];
  const requestStatus = async (id: string) =>
    (
      await owner.query<{ status: string }>(
        'SELECT status FROM commerce.action_requests WHERE id = $1',
        [id],
      )
    ).rows[0]?.status;
  const executions = async (id: string) =>
    (
      await owner.query('SELECT 1 FROM commerce.action_executions WHERE action_request_id = $1', [
        id,
      ])
    ).rowCount;
  const request = (orderId: string, ctx = ana, key = randomUUID()) =>
    createActionRequest(db, ctx, {
      orderId,
      reasonCode: 'customer_request',
      expectedVersion: 1,
      idempotencyKey: key,
    });
  const execute = (
    orderId: string,
    actionRequestId: string,
    key: string,
    over: Partial<{ reasonCode: string; expectedVersion: number }> = {},
    ctx = ana,
  ) =>
    executeUpdateOrder(db, ctx, {
      orderId,
      action: 'request_cancellation',
      reasonCode: over.reasonCode ?? 'customer_request',
      expectedVersion: over.expectedVersion ?? 1,
      actionRequestId,
      idempotencyKey: key,
    });

  beforeAll(async () => {
    await migrate({ adminUrl: adminUrl!, migratorUrl: migratorUrl!, runtimeUrl: runtimeUrl! });
    await seedCommerceDomain(migratorUrl!, piiKey!);
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
    await db.destroy();
  });

  it('binds a request to resource, canonical payload, version, policy and a 15-minute TTL', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    expect(created).toMatchObject({
      tool: 'update_order',
      resourceId: orderId,
      expectedVersion: 1,
      policyVersion: 'policy.v1',
      status: 'PENDING',
      requesterSubjectId: FIXTURES.subjects.ana,
      canonicalArgs: {
        order_id: orderId,
        action: 'request_cancellation',
        reason_code: 'customer_request',
        expected_version: 1,
      },
    });
    expect(created.canonicalArgsHash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = new Date(created.expiresAt).getTime() - new Date(created.createdAt).getTime();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
    // Approvers see the tenant's queue; another customer cannot see it.
    expect(
      (await listActionRequests(db, approver, { status: 'PENDING' })).map((r) => r.id),
    ).toContain(created.id);
    await expect(getActionRequest(db, ben, created.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(request(orderId, ben)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses self-approval, admin approval and any approval without the approver role', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    for (const ctx of [ana, support, admin]) {
      await expect(
        decideApproval(db, ctx, { actionRequestId: created.id, decision: 'APPROVED' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const supportRequest = await createActionRequest(db, support, {
      orderId: await confirmedOrder(),
      reasonCode: 'duplicate_order',
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    await expect(
      decideApproval(db, support, { actionRequestId: supportRequest.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Without a decision, executing is refused and nothing changes.
    await expect(execute(orderId, created.id, 'k-no-decision')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    // A made-up request id is not an approval either.
    await expect(execute(orderId, randomUUID(), 'k-made-up')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(await order(orderId)).toEqual({ status: 'CONFIRMED', version: 1 });
  });

  it('rejection and expiry produce zero domain changes and are terminal', async () => {
    const rejectedOrder = await confirmedOrder();
    const rejected = await request(rejectedOrder);
    await decideApproval(db, approver, {
      actionRequestId: rejected.id,
      decision: 'REJECTED',
      reason: 'no',
    });
    await expect(
      decideApproval(db, approver, { actionRequestId: rejected.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(execute(rejectedOrder, rejected.id, 'k-rejected')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(await order(rejectedOrder)).toEqual({ status: 'CONFIRMED', version: 1 });

    const lateOrder = await confirmedOrder();
    const late = await request(lateOrder);
    await owner.query(
      `UPDATE commerce.action_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [late.id],
    );
    await expect(
      decideApproval(db, approver, { actionRequestId: late.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await requestStatus(late.id)).toBe('EXPIRED');

    const expiringOrder = await confirmedOrder();
    const expiring = await request(expiringOrder);
    await decideApproval(db, approver, { actionRequestId: expiring.id, decision: 'APPROVED' });
    await owner.query(
      `UPDATE commerce.action_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expiring.id],
    );
    await expect(execute(expiringOrder, expiring.id, 'k-expired')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await requestStatus(expiring.id)).toBe('EXPIRED');
    expect(await order(expiringOrder)).toEqual({ status: 'CONFIRMED', version: 1 });
    expect(await executions(expiring.id)).toBe(0);
  });

  it('refuses a changed payload or a changed order and requires a new request', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    await decideApproval(db, approver, { actionRequestId: created.id, decision: 'APPROVED' });
    await expect(
      execute(orderId, created.id, 'k-altered', { reasonCode: 'other' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      execute(orderId, created.id, 'k-altered-2', { expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await order(orderId)).toEqual({ status: 'CONFIRMED', version: 1 });
    expect(await requestStatus(created.id)).toBe('APPROVED');
    // The order changes after approval: the approval becomes STALE and cannot be used.
    await owner.query('UPDATE commerce.orders SET version = 2 WHERE id = $1', [orderId]);
    await expect(execute(orderId, created.id, 'k-stale')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await requestStatus(created.id)).toBe('STALE');
    expect(await order(orderId)).toEqual({ status: 'CONFIRMED', version: 2 });
    expect(await executions(created.id)).toBe(0);
  });

  it('executes once: changes only status and version, keeps reservations, audits and emits OrderChanged', async () => {
    const orderId = await confirmedOrder();
    const reservationsBefore = (
      await owner.query('SELECT count(*)::int AS n FROM commerce.reservations')
    ).rows[0] as { n: number };
    const created = await request(orderId);
    await decideApproval(db, approver, { actionRequestId: created.id, decision: 'APPROVED' });
    const result = await execute(orderId, created.id, 'k-exec-0001');
    expect(result).toEqual({ orderId, status: 'CANCELLATION_REQUESTED', version: 2 });
    expect(await order(orderId)).toEqual({ status: 'CANCELLATION_REQUESTED', version: 2 });
    expect(await requestStatus(created.id)).toBe('EXECUTED');
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM commerce.reservations')).rows[0],
    ).toEqual(reservationsBefore);
    const audit = await owner.query<{ action: string }>(
      `SELECT action FROM commerce.audit_events WHERE resource_id IN ($1, $2) AND outcome = 'ALLOWED' ORDER BY recorded_at`,
      [orderId, created.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'action_requests.create',
        'approvals.approve',
        'orders.update_order',
        'approvals.consume',
      ]),
    );
    const outbox = await owner.query(
      `SELECT payload FROM commerce.outbox WHERE aggregate_id = $1`,
      [orderId],
    );
    expect(outbox.rows).toEqual([
      {
        payload: {
          type: 'OrderChanged',
          status: 'CANCELLATION_REQUESTED',
          actionRequestId: created.id,
        },
      },
    ]);
  });

  it('recovers the stored result after a lost response and rejects a replay with a new key', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    await decideApproval(db, approver, { actionRequestId: created.id, decision: 'APPROVED' });
    const first = await execute(orderId, created.id, 'k-retry-0001');
    // The client never saw the response and retries with the same key.
    const retry = await execute(orderId, created.id, 'k-retry-0001');
    expect(retry).toEqual(first);
    await expect(execute(orderId, created.id, 'k-replay-0002')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await order(orderId)).toEqual({ status: 'CANCELLATION_REQUESTED', version: 2 });
    expect(await executions(created.id)).toBe(1);
  });

  it('lets exactly one of two concurrent executions with different keys succeed', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    await decideApproval(db, approver, { actionRequestId: created.id, decision: 'APPROVED' });
    const results = await Promise.allSettled([
      execute(orderId, created.id, 'k-race-0001'),
      execute(orderId, created.id, 'k-race-0002'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });
    expect(await executions(created.id)).toBe(1);
    expect(await order(orderId)).toEqual({ status: 'CANCELLATION_REQUESTED', version: 2 });
  });

  it('refuses an order already in fulfillment, without touching state or reservations, and offers support', async () => {
    await expect(
      createActionRequest(db, ana, {
        orderId: FIXTURES.orders.anaPartial,
        reasonCode: 'customer_request',
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { offer: 'support' } });
    expect(await order(FIXTURES.orders.anaPartial)).toMatchObject({ status: 'FULFILLING' });
  });

  it('does not execute when the requester was revoked after approval', async () => {
    const orderId = await confirmedOrder();
    const created = await request(orderId);
    await decideApproval(db, approver, { actionRequestId: created.id, decision: 'APPROVED' });
    await owner.query('UPDATE commerce.memberships SET enabled = false WHERE subject_id = $1', [
      FIXTURES.subjects.ana,
    ]);
    try {
      await expect(execute(orderId, created.id, 'k-revoked')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    } finally {
      await owner.query('UPDATE commerce.memberships SET enabled = true WHERE subject_id = $1', [
        FIXTURES.subjects.ana,
      ]);
    }
    expect(await order(orderId)).toEqual({ status: 'CONFIRMED', version: 1 });
    // Someone else holding the request id cannot use it either.
    await expect(execute(orderId, created.id, 'k-other-user', {}, support)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
  });
});
