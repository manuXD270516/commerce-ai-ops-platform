/** Stable fixture identifiers from evals/fixtures/commerce-domain/0.1.0/seed.json */
export const FIXTURES = {
  tenants: {
    acme: '00000000-0000-4000-8000-000000000001',
    globex: '00000000-0000-4000-8000-000000000002',
  },
  customers: {
    ana: '00000000-0000-4000-8000-000000000011',
    ben: '00000000-0000-4000-8000-000000000012',
    cara: '00000000-0000-4000-8000-000000000021',
  },
  subjects: {
    ana: 'acme-customer-ana',
    ben: 'acme-customer-ben',
    cara: 'globex-customer-cara',
    acmeSupport: 'acme-support',
    acmeInventory: 'acme-inventory',
    acmeApprover: 'acme-approver',
    acmeAdmin: 'acme-admin',
    globexSupport: 'globex-support',
  },
  orders: {
    anaPartial: '00000000-0000-4000-8000-000000000401',
    benConfirmed: '00000000-0000-4000-8000-000000000402',
    caraPlaced: '00000000-0000-4000-8000-000000000501',
  },
  skus: {
    nb16: '00000000-0000-4000-8000-000000000111',
    nb32: '00000000-0000-4000-8000-000000000112',
    nbWs: '00000000-0000-4000-8000-000000000113',
    mouse: '00000000-0000-4000-8000-000000000114',
  },
  products: {
    notebook: '00000000-0000-4000-8000-000000000101',
  },
  warehouses: {
    acmeEast: '00000000-0000-4000-8000-000000000301',
  },
} as const;
