import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  checkInventory,
  createActionRequest,
  createDb,
  createPool,
  createSupportTicket,
  decideApproval,
  executeUpdateOrder,
  getProduct,
  listCatalog,
  migrate,
  recordConsent,
  seedCommerceDomain,
  ticketConsentPayload,
} from '../src/index.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
const runtimeUrl = process.env.DATABASE_URL;
const piiKey = process.env.PII_ENCRYPTION_KEY;
const enabled = Boolean(adminUrl && migratorUrl && runtimeUrl && piiKey);

const ana = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer' as const,
  customerId: FIXTURES.customers.ana,
  policyVersion: 'policy.v1',
  correlationId: 'ops-ana-01',
};

const support = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.acmeSupport,
  role: 'support' as const,
  policyVersion: 'policy.v1',
  correlationId: 'ops-support-01',
};

const inventory = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.acmeInventory,
  role: 'inventory' as const,
  policyVersion: 'policy.v1',
};

const approver = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.acmeApprover,
  role: 'approver' as const,
  policyVersion: 'policy.v1',
};

describe.skipIf(!enabled)('catalog, tickets and approvals', () => {
  const pool = createPool(runtimeUrl!);
  const db = createDb(pool);

  beforeAll(async () => {
    await migrate({ adminUrl: adminUrl!, migratorUrl: migratorUrl!, runtimeUrl: runtimeUrl! });
    await seedCommerceDomain(migratorUrl!, piiKey!);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('applies a strict USD 1500 notebook budget before ranking', async () => {
    const page = await listCatalog(db, ana, {
      category: 'notebook',
      currency: 'USD',
      priceLt: 150_000,
      region: 'us-east',
    });
    expect(page.items.every((sku) => sku.currency === 'USD' && sku.priceMinor < 150_000)).toBe(
      true,
    );
    expect(page.items.map((sku) => sku.skuCode).sort()).toEqual(['NB-DEV-16', 'NB-DEV-32']);
    expect(page.items.some((sku) => sku.skuCode === 'NB-WS-64')).toBe(false);
  });

  it('hides Globex catalog rows and unpublished data from Ana', async () => {
    const page = await listCatalog(db, ana, { limit: 50 });
    expect(page.items.some((sku) => sku.skuCode.startsWith('GX-'))).toBe(false);
    await expect(getProduct(db, ana, '00000000-0000-4000-8000-000000000201')).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
  });

  it('returns availability for a published SKU in the requested region', async () => {
    const stock = await checkInventory(db, ana, FIXTURES.skus.nb16, 'us-east');
    expect(stock.available).toBe(11);
    expect(stock.region).toBe('us-east');
    expect(stock.detail).toBeUndefined();
  });

  it('excludes a SKU priced exactly USD 1500 from a strict < 1500 budget', async () => {
    const below = await listCatalog(db, ana, { category: 'notebook', priceLt: 150_000 });
    expect(below.items.some((sku) => sku.id === FIXTURES.skus.nb32AtBudget)).toBe(false);
    const above = await listCatalog(db, ana, { category: 'notebook', priceLt: 150_001 });
    expect(above.items.some((sku) => sku.id === FIXTURES.skus.nb32AtBudget)).toBe(true);
  });

  it('hides draft products from customers and support but not from inventory', async () => {
    for (const actor of [ana, support]) {
      const page = await listCatalog(db, actor, { limit: 50 });
      expect(page.items.some((sku) => sku.id === FIXTURES.skus.draftProto)).toBe(false);
      await expect(getProduct(db, actor, FIXTURES.products.draftProto)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(checkInventory(db, actor, FIXTURES.skus.draftProto)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    const stock = await checkInventory(db, inventory, FIXTURES.skus.draftProto);
    expect(stock.detail).toMatchObject({ onHand: 9, reserved: 0, safetyStock: 5 });
  });

  it('paginates deterministically by (price_minor, sku_code) without gaps or duplicates', async () => {
    const full = await listCatalog(db, ana, { limit: 50 });
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await listCatalog(db, ana, { limit: 2, cursor });
      walked.push(...page.items.map((sku) => sku.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(full.items.map((sku) => sku.id));
    const prices = full.items.map((sku) => sku.priceMinor);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('rejects invalid filters with VALIDATION_ERROR', async () => {
    for (const filters of [
      { currency: 'EUR' },
      { limit: 51 },
      { limit: 0 },
      { priceLt: -1 },
      { priceLt: 1.5 },
      { cursor: 'not-a-cursor' },
    ]) {
      await expect(listCatalog(db, ana, filters)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('requires a recorded consent for tickets and deduplicates retries', async () => {
    const ticket = {
      orderId: FIXTURES.orders.anaPartial,
      category: 'delivery_delay' as const,
      summary: 'Mi paquete está atrasado',
    };
    await expect(
      createSupportTicket(db, ana, {
        ...ticket,
        consentId: '00000000-0000-4000-8000-0000000000aa',
        idempotencyKey: 'tix-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { reason: 'CONSENT_NOT_FOUND' } });
    const consent = await recordConsent(db, ana, {
      command: 'create_support_ticket',
      payload: ticketConsentPayload(ticket),
    });
    const first = await createSupportTicket(db, ana, {
      ...ticket,
      consentId: consent.id,
      idempotencyKey: 'tix-1',
    });
    const second = await createSupportTicket(db, ana, {
      ...ticket,
      consentId: consent.id,
      idempotencyKey: 'tix-1',
    });
    expect(second.id).toBe(first.id);
    expect(first.customerId).toBe(FIXTURES.customers.ana);
    await expect(
      createSupportTicket(db, support, {
        ...ticket,
        consentId: consent.id,
        idempotencyKey: 'tix-2',
      }),
    ).rejects.toMatchObject({ details: { reason: 'CONSENT_NOT_FOUND' } });
    await expect(
      createSupportTicket(db, inventory, {
        ...ticket,
        consentId: consent.id,
        idempotencyKey: 'tix-3',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('limits ticket creation per subject in PostgreSQL', async () => {
    const created: string[] = [];
    let limited: unknown;
    for (let i = 0; i < 6; i++) {
      const ticket = {
        category: 'other' as const,
        summary: `Consulta general número ${String(i)}`,
      };
      const consent = await recordConsent(db, support, {
        command: 'create_support_ticket',
        payload: ticketConsentPayload({ ...ticket, orderId: FIXTURES.orders.benConfirmed }),
      });
      try {
        const t = await createSupportTicket(db, support, {
          ...ticket,
          orderId: FIXTURES.orders.benConfirmed,
          consentId: consent.id,
          idempotencyKey: `rate-${String(i)}-key`,
        });
        created.push(t.id);
      } catch (error) {
        limited = error;
      }
    }
    expect(created).toHaveLength(5);
    expect(limited).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
  it('consumes an approval once and rejects replay, stale payload and self-approval', async () => {
    const request = await createActionRequest(db, support, {
      tool: 'update_order',
      resourceId: FIXTURES.orders.benConfirmed,
      canonicalArgs: { action: 'request_cancellation', expectedVersion: 1 },
      idempotencyKey: 'ar-1',
    });
    await expect(
      decideApproval(db, support, { actionRequestId: request.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decideApproval(db, approver, { actionRequestId: request.id, decision: 'APPROVED' });
    const first = await executeUpdateOrder(db, support, {
      orderId: FIXTURES.orders.benConfirmed,
      action: 'request_cancellation',
      expectedVersion: 1,
      actionRequestId: request.id,
      idempotencyKey: 'exec-1',
    });
    expect(first.status).toBe('CANCELLATION_REQUESTED');
    const replay = await executeUpdateOrder(db, support, {
      orderId: FIXTURES.orders.benConfirmed,
      action: 'request_cancellation',
      expectedVersion: 1,
      actionRequestId: request.id,
      idempotencyKey: 'exec-1',
    });
    expect(replay.version).toBe(first.version);
    await expect(
      executeUpdateOrder(db, support, {
        orderId: FIXTURES.orders.benConfirmed,
        action: 'request_cancellation',
        expectedVersion: 1,
        actionRequestId: request.id,
        idempotencyKey: 'exec-2',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
