import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { assertRole } from './actors.js';
import { APPROVAL_TTL_MS, POLICY_VERSION } from './constants.js';
import type { Database } from './db.js';
import { DomainError, isDomainError } from './errors.js';
import { commitIdempotent, payloadHash } from './idempotency.js';
import { appendAudit, appendOutbox, withUnitOfWork, type DomainTrx } from './uow.js';

export const CANCELLATION_REASONS = [
  'customer_request',
  'duplicate_order',
  'delivery_too_late',
  'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** The exact command an approval authorizes; its hash binds request, approval and execution. */
export interface CancellationArgs {
  readonly order_id: string;
  readonly action: 'request_cancellation';
  readonly reason_code: CancellationReason;
  readonly expected_version: number;
}

export function cancellationArgs(input: {
  orderId: string;
  reasonCode: string;
  expectedVersion: number;
}): CancellationArgs {
  if (!CANCELLATION_REASONS.includes(input.reasonCode as CancellationReason)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown reason_code', { field: 'reason_code' });
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new DomainError('VALIDATION_ERROR', 'expected_version must be a positive integer', {
      field: 'expected_version',
    });
  }
  return {
    order_id: input.orderId,
    action: 'request_cancellation',
    reason_code: input.reasonCode as CancellationReason,
    expected_version: input.expectedVersion,
  };
}

export interface ActionRequestRecord {
  readonly id: string;
  readonly tool: string;
  readonly resourceId: string;
  readonly runId: string | null;
  readonly canonicalArgs: unknown;
  readonly canonicalArgsHash: string;
  readonly expectedVersion: number;
  readonly policyVersion: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly requesterSubjectId: string;
  readonly decision?: {
    readonly approverSubjectId: string;
    readonly decision: string;
    readonly reason: string | null;
    readonly decidedAt: string;
  };
}

/** Effect the cancellation command has, shown to the approver before deciding. */
export const CANCELLATION_EFFECT =
  'La orden pasa a CANCELLATION_REQUESTED y su versión aumenta en 1. No cancela con el transportista, no libera reservas y no reembolsa.';

/**
 * Pre-conditions of the only commercial mutation: PLACED or CONFIRMED, no fulfillment started.
 * Returns the reason it is not eligible, or undefined.
 */
async function ineligibility(
  trx: DomainTrx,
  order: { id: string; status: string },
): Promise<string | undefined> {
  if (order.status !== 'PLACED' && order.status !== 'CONFIRMED') {
    return `order is ${order.status}`;
  }
  const started = await trx
    .selectFrom('fulfillments')
    .select('id')
    .where('order_id', '=', order.id)
    .executeTakeFirst();
  return started ? 'fulfillment already started' : undefined;
}

/**
 * Creates the immutable request the user confirmed in the console. It binds tool, resource,
 * canonical arguments (hash), requester, tenant, expected_version, policy_version and a 15-minute
 * TTL. Nothing executes here.
 */
export async function createActionRequest(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    orderId: string;
    reasonCode: string;
    expectedVersion: number;
    runId?: string;
    idempotencyKey: string;
  },
): Promise<ActionRequestRecord> {
  assertRole(ctx, ['customer', 'support']);
  const args = cancellationArgs(input);
  return commitIdempotent(
    db,
    ctx,
    'governance.action_request',
    input.idempotencyKey,
    { ...args, run_id: input.runId ?? null },
    async (trx) => {
      // RLS limits customers to their own orders: a foreign order is simply not found.
      const order = await trx
        .selectFrom('orders')
        .select(['id', 'status', 'version'])
        .where('id', '=', args.order_id)
        .executeTakeFirst();
      if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
      if (order.version !== args.expected_version) {
        throw new DomainError('CONFLICT', 'Order changed; review it again before requesting', {
          currentVersion: order.version,
        });
      }
      const blocked = await ineligibility(trx, order);
      if (blocked) {
        throw new DomainError('CONFLICT', `Cancellation cannot be requested: ${blocked}`, {
          offer: 'support',
        });
      }
      if (input.runId) {
        const run = await trx
          .selectFrom('agent_runs')
          .select('subject_id')
          .where('id', '=', input.runId)
          .executeTakeFirst();
        if (run?.subject_id !== ctx.subjectId) {
          throw new DomainError('NOT_FOUND', 'Run not found');
        }
      }
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      await trx
        .insertInto('action_requests')
        .values({
          tenant_id: ctx.tenantId,
          id,
          run_id: input.runId ?? null,
          requester_subject_id: ctx.subjectId,
          tool: 'update_order',
          resource_id: args.order_id,
          canonical_args: JSON.stringify(args),
          canonical_args_hash: payloadHash(args),
          expected_version: args.expected_version,
          policy_version: POLICY_VERSION,
          expires_at: expiresAt,
          status: 'PENDING',
          decided_at: null,
        })
        .execute();
      await appendAudit(trx, ctx, {
        action: 'action_requests.create',
        resourceType: 'action_request',
        resourceId: id,
        outcome: 'ALLOWED',
      });
      return readRequest(trx, id);
    },
  );
}

/**
 * Human decision through an authenticated endpoint. Only the approver role decides, never the
 * requester (separation of duties) and never admin implicitly; there is no tool for it. A pending
 * request past its TTL is marked EXPIRED instead.
 */
export async function decideApproval(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { actionRequestId: string; decision: 'APPROVED' | 'REJECTED'; reason?: string },
): Promise<ActionRequestRecord> {
  if (ctx.role !== 'approver') {
    await deniedAudit(db, ctx, 'approvals.decide', input.actionRequestId);
    throw new DomainError('FORBIDDEN', 'Only an approver may decide');
  }
  // The type says APPROVED | REJECTED, but the value arrives from an HTTP body.
  const decision: string = input.decision;
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw new DomainError('VALIDATION_ERROR', 'decision must be APPROVED or REJECTED', {
      field: 'decision',
    });
  }
  return markOnFailure(db, ctx, input.actionRequestId, () =>
    withUnitOfWork(db, ctx, async (trx) => {
      const request = await trx
        .selectFrom('action_requests')
        .selectAll()
        .where('id', '=', input.actionRequestId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) throw new DomainError('NOT_FOUND', 'Action request not found');
      if (request.requester_subject_id === ctx.subjectId) {
        throw new DomainError('FORBIDDEN', 'Approver must be distinct from requester');
      }
      if (request.status !== 'PENDING') {
        throw new DomainError('CONFLICT', `Action request is ${request.status}`);
      }
      if (request.expires_at.getTime() <= Date.now()) {
        throw new DomainError('CONFLICT', 'Action request expired', { markRequest: 'EXPIRED' });
      }
      // The approver decides on the order as it was requested; if it moved, the decision would be
      // about something else, so the request becomes STALE and a new one is needed.
      const order = await trx
        .selectFrom('orders')
        .select('version')
        .where('id', '=', request.resource_id)
        .executeTakeFirst();
      if (input.decision === 'APPROVED' && order?.version !== request.expected_version) {
        throw new DomainError('CONFLICT', 'Order changed since the request was made', {
          markRequest: 'STALE',
          currentVersion: order?.version ?? null,
        });
      }
      await trx
        .insertInto('approvals')
        .values({
          tenant_id: ctx.tenantId,
          id: randomUUID(),
          action_request_id: request.id,
          approver_subject_id: ctx.subjectId,
          decision: input.decision,
          reason: input.reason?.slice(0, 500) ?? null,
          expires_at: request.expires_at,
          canonical_args_hash: request.canonical_args_hash,
        })
        .execute();
      await trx
        .updateTable('action_requests')
        .set({ status: input.decision, decided_at: new Date() })
        .where('id', '=', request.id)
        .execute();
      await appendAudit(trx, ctx, {
        action: input.decision === 'APPROVED' ? 'approvals.approve' : 'approvals.reject',
        resourceType: 'action_request',
        resourceId: request.id,
        outcome: 'ALLOWED',
      });
      return readRequest(trx, request.id);
    }),
  );
}

/**
 * The single privileged command. In one transaction it locks the request, checks the requester's
 * current membership, the approval (decision, distinct approver, TTL, payload hash), the order
 * version and eligibility, then writes the transition, the execution (consumes the approval),
 * the idempotency record, outbox and audit. A retry with the same key replays the stored result;
 * any other key finds the approval consumed.
 */
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
  assertRole(ctx, ['customer', 'support']);
  const args = cancellationArgs({
    orderId: input.orderId,
    reasonCode: input.reasonCode ?? '',
    expectedVersion: input.expectedVersion,
  });
  return markOnFailure(db, ctx, input.actionRequestId, () =>
    commitIdempotent(db, ctx, 'orders.update_order', input.idempotencyKey, args, async (trx) => {
      const request = await trx
        .selectFrom('action_requests')
        .selectAll()
        .where('id', '=', input.actionRequestId)
        .forUpdate()
        .executeTakeFirst();
      // An id is a reference, not a bearer credential: it must be this user's request.
      if (!request)
        throw new DomainError('APPROVAL_REQUIRED', 'No valid approval for this command');
      if (request.requester_subject_id !== ctx.subjectId) {
        throw new DomainError('APPROVAL_REQUIRED', 'No valid approval for this command');
      }
      if (request.tool !== 'update_order' || request.resource_id !== args.order_id) {
        throw new DomainError('FORBIDDEN', 'Action request does not match the command');
      }
      const membership = await trx
        .selectFrom('memberships')
        .select('role')
        .where('subject_id', '=', ctx.subjectId)
        .where('enabled', '=', true)
        .executeTakeFirst();
      if (!membership) throw new DomainError('FORBIDDEN', 'Membership revoked');
      if (request.status === 'EXECUTED') {
        throw new DomainError('CONFLICT', 'Approval already consumed');
      }
      if (request.status !== 'APPROVED') {
        throw new DomainError('APPROVAL_REQUIRED', `Action request is ${request.status}`);
      }
      const approval = await trx
        .selectFrom('approvals')
        .selectAll()
        .where('action_request_id', '=', request.id)
        .executeTakeFirst();
      if (
        approval?.decision !== 'APPROVED' ||
        approval.approver_subject_id === request.requester_subject_id
      ) {
        throw new DomainError('APPROVAL_REQUIRED', 'No valid approval for this command');
      }
      if (request.expires_at.getTime() <= Date.now()) {
        throw new DomainError('CONFLICT', 'Approval expired', { markRequest: 'EXPIRED' });
      }
      const hash = payloadHash(args);
      if (hash !== request.canonical_args_hash || hash !== approval.canonical_args_hash) {
        // A different command than the one approved: refused, and the approval stays as it was.
        throw new DomainError('CONFLICT', 'Payload does not match the approved request');
      }
      const order = await trx
        .selectFrom('orders')
        .select(['id', 'status', 'version'])
        .where('id', '=', args.order_id)
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
      if (order.version !== args.expected_version) {
        throw new DomainError('CONFLICT', 'Order changed since approval', { markRequest: 'STALE' });
      }
      const blocked = await ineligibility(trx, order);
      if (blocked) {
        throw new DomainError('CONFLICT', `Cancellation cannot be requested: ${blocked}`, {
          markRequest: 'FAILED',
          offer: 'support',
        });
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
        payload: {
          type: 'OrderChanged',
          status: 'CANCELLATION_REQUESTED',
          actionRequestId: request.id,
        },
      });
      await appendAudit(trx, ctx, {
        action: 'orders.update_order',
        resourceType: 'order',
        resourceId: order.id,
        outcome: 'ALLOWED',
      });
      await appendAudit(trx, ctx, {
        action: 'approvals.consume',
        resourceType: 'action_request',
        resourceId: request.id,
        outcome: 'ALLOWED',
      });
      return { orderId: order.id, status: 'CANCELLATION_REQUESTED', version: nextVersion };
    }),
  );
}

export async function listActionRequests(
  db: Kysely<Database>,
  ctx: ActorContext,
  filter: { status?: string } = {},
): Promise<readonly ActionRequestRecord[]> {
  assertRole(ctx, ['customer', 'support', 'approver']);
  return withUnitOfWork(db, ctx, async (trx) => {
    let query = trx
      .selectFrom('action_requests')
      .select('id')
      .orderBy('created_at', 'desc')
      .limit(50);
    // Approvers review the tenant's requests; everyone else sees only their own.
    if (ctx.role !== 'approver') query = query.where('requester_subject_id', '=', ctx.subjectId);
    if (filter.status) query = query.where('status', '=', filter.status);
    const ids = await query.execute();
    const records: ActionRequestRecord[] = [];
    for (const { id } of ids) records.push(await readRequest(trx, id));
    return records;
  });
}

export async function getActionRequest(
  db: Kysely<Database>,
  ctx: ActorContext,
  id: string,
): Promise<ActionRequestRecord> {
  assertRole(ctx, ['customer', 'support', 'approver']);
  return withUnitOfWork(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('action_requests')
      .select('requester_subject_id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || (ctx.role !== 'approver' && row.requester_subject_id !== ctx.subjectId)) {
      throw new DomainError('NOT_FOUND', 'Action request not found');
    }
    return readRequest(trx, id);
  });
}

export type RunApprovalStatus = 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'STALE' | 'FAILED';

/**
 * Decision on the latest action request of a run, read from the database. Undefined while there
 * is no request yet (the user has not confirmed) or it is still pending and in time. EXECUTED is
 * reported as APPROVED so a resumed run replays the stored result through idempotency.
 */
export async function runApprovalOutcome(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<{ status: RunApprovalStatus; actionRequestId: string } | undefined> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const request = await trx
      .selectFrom('action_requests')
      .select(['id', 'status', 'expires_at'])
      .where('run_id', '=', runId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!request) return undefined;
    if (request.status === 'PENDING') {
      if (request.expires_at.getTime() > Date.now()) return undefined;
      await trx
        .updateTable('action_requests')
        .set({ status: 'EXPIRED' })
        .where('id', '=', request.id)
        .where('status', '=', 'PENDING')
        .execute();
      return { status: 'EXPIRED', actionRequestId: request.id };
    }
    const status = request.status === 'EXECUTED' ? 'APPROVED' : request.status;
    return { status: status as RunApprovalStatus, actionRequestId: request.id };
  });
}

/**
 * Some refusals must outlive the rolled-back transaction (an expired or stale request stays so).
 * They are recorded in a separate unit of work after the failure, together with a DENIED audit.
 */
async function markOnFailure<T>(
  db: Kysely<Database>,
  ctx: ActorContext,
  requestId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isDomainError(error)) {
      const mark = error.details.markRequest;
      await withUnitOfWork(db, ctx, async (trx) => {
        if (typeof mark === 'string') {
          await trx
            .updateTable('action_requests')
            .set({ status: mark })
            .where('id', '=', requestId)
            .where('status', 'in', ['PENDING', 'APPROVED'])
            .execute();
        }
        await appendAudit(trx, ctx, {
          action: 'action_requests.denied',
          resourceType: 'action_request',
          resourceId: /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : undefined,
          outcome: 'DENIED',
        });
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function deniedAudit(
  db: Kysely<Database>,
  ctx: ActorContext,
  action: string,
  resourceId: string,
): Promise<void> {
  await withUnitOfWork(db, ctx, (trx) =>
    appendAudit(trx, ctx, {
      action,
      resourceType: 'action_request',
      resourceId: /^[0-9a-f-]{36}$/i.test(resourceId) ? resourceId : undefined,
      outcome: 'DENIED',
    }),
  ).catch(() => undefined);
}

async function readRequest(trx: DomainTrx, id: string): Promise<ActionRequestRecord> {
  const row = await trx
    .selectFrom('action_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const approval = await trx
    .selectFrom('approvals')
    .selectAll()
    .where('action_request_id', '=', id)
    .executeTakeFirst();
  return {
    id: row.id,
    tool: row.tool,
    resourceId: row.resource_id,
    runId: row.run_id,
    canonicalArgs: row.canonical_args,
    canonicalArgsHash: row.canonical_args_hash,
    expectedVersion: row.expected_version,
    policyVersion: row.policy_version,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    requesterSubjectId: row.requester_subject_id,
    ...(approval
      ? {
          decision: {
            approverSubjectId: approval.approver_subject_id,
            decision: approval.decision,
            reason: approval.reason,
            decidedAt: approval.decided_at.toISOString(),
          },
        }
      : {}),
  };
}
