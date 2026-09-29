import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext, Role } from './access.js';
import { ROLES } from './access.js';
import { POLICY_VERSION } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';

export async function resolveActor(
  db: Kysely<Database>,
  input: { tenantId: string; subjectId: string; correlationId?: string },
): Promise<ActorContext> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`.execute(trx);
    await sql`SELECT set_config('app.subject_id', ${input.subjectId}, true)`.execute(trx);
    await sql`SELECT set_config('app.role', 'support', true)`.execute(trx);
    const membership = await trx
      .selectFrom('memberships')
      .selectAll()
      .where('subject_id', '=', input.subjectId)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!membership || !isRole(membership.role)) {
      throw new DomainError('FORBIDDEN', 'Unknown or disabled membership');
    }
    const customer =
      membership.role === 'customer'
        ? await trx
            .selectFrom('customers')
            .select('id')
            .where('subject_id', '=', input.subjectId)
            .executeTakeFirst()
        : undefined;
    if (membership.role === 'customer' && customer === undefined) {
      throw new DomainError('FORBIDDEN', 'Customer membership has no customer record');
    }
    return {
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      role: membership.role,
      customerId: customer?.id,
      correlationId: input.correlationId,
      policyVersion: POLICY_VERSION,
    };
  });
}

export async function resolveTenantId(db: Kysely<Database>, slugOrId: string): Promise<string> {
  const byId = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', slugOrId)
    .executeTakeFirst();
  if (byId) return byId.id;
  const bySlug = await db
    .selectFrom('tenants')
    .select('id')
    .where('slug', '=', slugOrId)
    .executeTakeFirst();
  if (!bySlug) throw new DomainError('NOT_FOUND', 'Tenant not found');
  return bySlug.id;
}

export function assertRole(ctx: ActorContext, allowed: readonly Role[]): void {
  if (!allowed.includes(ctx.role)) {
    throw new DomainError('FORBIDDEN', 'Role is not permitted for this command');
  }
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
