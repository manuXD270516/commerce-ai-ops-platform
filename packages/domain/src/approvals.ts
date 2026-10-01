import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { APPROVAL_TTL_MS, POLICY_VERSION } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { payloadHash } from './idempotency.js';
import { commitIdempotent } from './idempotency.js';
import { appendAudit, appendOutbox, withUnitOfWork } from './uow.js';

export interface ActionRequestRecord {
  readonly id: string;
  readonly tool: string;
  readonly resourceId: string;
  readonly canonicalArgs: unknown;
  readonly expectedVersion: number;
  readonly policyVersion: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly requesterSubjectId: string;
}

export async function createActionRequest(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    tool: 'update_order';
    resourceId: string;
    canonicalArgs: { action: 'request_cancellation'; expectedVersion: number };
    runId?: string;
    idempotencyKey: string;
  },
): Promise<ActionRequestRecord> {
  return commitIdempotent(
    db,
    ctx,
    'governance.action_request',
    input.idempotencyKey,
    input,
    async (trx) => {
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.resourceId)
        .executeTakeFirst();
      if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      const hash = payloadHash(input.canonicalArgs);
      await trx
        .insertInto('action_requests')
        .values({
          tenant_id: ctx.tenantId,
          id,
          run_id: input.runId ?? null,
          requester_subject_id: ctx.subjectId,
          tool: input.tool,
          resource_id: input.resourceId,
          canonical_args: input.canonicalArgs,
          canonical_args_hash: hash,
          expected_version: input.canonicalArgs.expectedVersion,
          policy_version: POLICY_VERSION,
          expires_at: expiresAt,
          status: 'PENDING',
        })
        .execute();
      await appendAudit(trx, ctx, {
        action: 'action_requests.create',
        resourceType: 'action_request',
        resourceId: id,
        outcome: 'ALLOWED',
      });
      return {
        id,
        tool: input.tool,
        resourceId: input.resourceId,
        canonicalArgs: input.canonicalArgs,
        expectedVersion: input.canonicalArgs.expectedVersion,
        policyVersion: POLICY_VERSION,
        status: 'PENDING',
        expiresAt: expiresAt.toISOString(),
        requesterSubjectId: ctx.subjectId,
      };
    },
  );
}

export async function decideApproval(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { actionRequestId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string },
): Promise<ActionRequestRecord> {
  if (ctx.role !== 'approver') {
    throw new DomainError('FORBIDDEN', 'Only an approver may decide');
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    const request = await trx
      .selectFrom('action_requests')
      .selectAll()
      .where('id', '=', input.actionRequestId)
      .executeTakeFirst();
    if (!request) throw new DomainError('NOT_FOUND', 'Action request not found');
    if (request.requester_subject_id === ctx.subjectId) {
      throw new DomainError('FORBIDDEN', 'Approver must be distinct from requester');
    }
    if (request.status !== 'PENDING') {
      throw new DomainError('CONFLICT', 'Action request is no longer pending');
    }
    if (request.expires_at.getTime() < Date.now()) {
      await trx
        .updateTable('action_requests')
        .set({ status: 'EXPIRED' })
        .where('id', '=', request.id)
        .execute();
      throw new DomainError('CONFLICT', 'Action request expired');
    }
    await trx
      .insertInto('approvals')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        action_request_id: request.id,
        approver_subject_id: ctx.subjectId,
        decision: input.decision,
        reason: input.reason ?? null,
        expires_at: request.expires_at,
      })
      .execute();
    const status = input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    await trx.updateTable('action_requests').set({ status }).where('id', '=', request.id).execute();
    await appendAudit(trx, ctx, {
      action: 'approvals.decide',
      resourceType: 'action_request',
      resourceId: request.id,
      outcome: 'ALLOWED',
    });
    return toRecord({ ...request, status });
  });
}

export async function executeUpdateOrder(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    orderId: string;
    action: 'request_cancellation';
    reasonCode?: string;
    expectedVersion: number;
    actionRequestId: string;
    idempotencyKey: string;
  },
): Promise<{ orderId: string; status: string; version: number }> {
  return commitIdempotent(db, ctx, 'orders.update', input.idempotencyKey, input, async (trx) => {
    const request = await trx
      .selectFrom('action_requests')
      .selectAll()
      .where('id', '=', input.actionRequestId)
      .executeTakeFirst();
    if (!request) throw new DomainError('APPROVAL_REQUIRED', 'No action request');
    if (request.tool !== 'update_order' || request.resource_id !== input.orderId) {
      throw new DomainError('FORBIDDEN', 'Action request does not match command');
    }
    if (request.requester_subject_id !== ctx.subjectId) {
      throw new DomainError('FORBIDDEN', 'Requester membership no longer matches');
    }
    const membership = await trx
      .selectFrom('memberships')
      .selectAll()
      .where('subject_id', '=', ctx.subjectId)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!membership) throw new DomainError('FORBIDDEN', 'Membership revoked');

    if (request.status === 'EXECUTED') {
      const prior = await trx
        .selectFrom('action_executions')
        .selectAll()
        .where('action_request_id', '=', request.id)
        .executeTakeFirst();
      if (prior && prior.idempotency_key !== input.idempotencyKey) {
        throw new DomainError('CONFLICT', 'Approval already consumed with a different key');
      }
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .executeTakeFirstOrThrow();
      return { orderId: order.id, status: order.status, version: order.version };
    }
    if (request.status !== 'APPROVED') {
      throw new DomainError('APPROVAL_REQUIRED', 'Privileged tool requires a valid approval');
    }
    if (request.expires_at.getTime() < Date.now()) {
      await trx
        .updateTable('action_requests')
        .set({ status: 'EXPIRED' })
        .where('id', '=', request.id)
        .execute();
      throw new DomainError('CONFLICT', 'Approval expired');
    }
    const argsHash = payloadHash({ action: input.action, expectedVersion: input.expectedVersion });
    if (
      argsHash !== request.canonical_args_hash ||
      request.expected_version !== input.expectedVersion
    ) {
      await trx
        .updateTable('action_requests')
        .set({ status: 'STALE' })
        .where('id', '=', request.id)
        .execute();
      throw new DomainError('CONFLICT', 'Payload or expected version does not match approval');
    }

    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', input.orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
    if (order.version !== input.expectedVersion) {
      await trx
        .updateTable('action_requests')
        .set({ status: 'STALE' })
        .where('id', '=', request.id)
        .execute();
      throw new DomainError('CONFLICT', 'Order version changed');
    }
    if (order.status !== 'PLACED' && order.status !== 'CONFIRMED') {
      throw new DomainError('CONFLICT', 'Order is not eligible for cancellation request');
    }
    const started = await trx
      .selectFrom('fulfillments')
      .select('id')
      .where('order_id', '=', order.id)
      .executeTakeFirst();
    if (started) {
      throw new DomainError('CONFLICT', 'Fulfillment already started');
    }

    const nextVersion = order.version + 1;
    await trx
      .updateTable('orders')
      .set({ status: 'CANCELLATION_REQUESTED', version: nextVersion, updated_at: new Date() })
      .where('id', '=', order.id)
      .where('version', '=', order.version)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('action_executions')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        action_request_id: request.id,
        idempotency_key: input.idempotencyKey,
        result_ref: order.id,
        status: 'SUCCEEDED',
      })
      .execute();
    await trx
      .updateTable('action_requests')
      .set({ status: 'EXECUTED' })
      .where('id', '=', request.id)
      .execute();
    await appendOutbox(trx, ctx, {
      aggregateType: 'order',
      aggregateId: order.id,
      aggregateVersion: nextVersion,
      payload: { type: 'OrderChanged', status: 'CANCELLATION_REQUESTED' },
    });
    await appendAudit(trx, ctx, {
      action: 'orders.update_order',
      resourceType: 'order',
      resourceId: order.id,
      outcome: 'ALLOWED',
    });
    return { orderId: order.id, status: 'CANCELLATION_REQUESTED', version: nextVersion };
  });
}

export async function listActionRequests(
  db: Kysely<Database>,
  ctx: ActorContext,
): Promise<readonly ActionRequestRecord[]> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('action_requests')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toRecord);
  });
}

function toRecord(row: {
  id: string;
  tool: string;
  resource_id: string;
  canonical_args: unknown;
  expected_version: number;
  policy_version: string;
  status: string;
  expires_at: Date;
  requester_subject_id: string;
}): ActionRequestRecord {
  return {
    id: row.id,
    tool: row.tool,
    resourceId: row.resource_id,
    canonicalArgs: row.canonical_args,
    expectedVersion: row.expected_version,
    policyVersion: row.policy_version,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    requesterSubjectId: row.requester_subject_id,
  };
}
