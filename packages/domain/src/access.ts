export const ROLES = ['customer', 'support', 'inventory', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface ActorContext {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly role: Role;
  readonly customerId?: string;
  readonly correlationId?: string;
  readonly policyVersion: string;
}

export function assertCustomerScope(ctx: ActorContext): void {
  if (ctx.role === 'customer' && ctx.customerId === undefined) {
    throw new Error('customer role requires customerId on the actor context');
  }
}
