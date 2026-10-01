import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { DEGRADED_URL } from '../playwright.config';

const ACME = '00000000-0000-4000-8000-000000000001';
const ANA_ORDER = '00000000-0000-4000-8000-000000000401';
const BEN_ORDER = '00000000-0000-4000-8000-000000000402';
const BEN = '00000000-0000-4000-8000-000000000012';

async function db<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, label: RegExp, base = '') {
  await page.goto(`${base}/login`);
  await page.getByRole('button', { name: label }).click();
  await expect(page.getByRole('heading', { name: 'Consola operacional' })).toBeVisible();
}

async function newUser(browser: Browser, label: RegExp) {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const page = await context.newPage();
  await signIn(page, label);
  return page;
}

async function ask(page: Page, message: string) {
  await page.goto('/runs');
  await page.getByRole('textbox', { name: 'Consulta', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Enviar' }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

test('customer: catalog filters, timeline with simulated and stale labels, no inventory or approvals', async ({
  page,
}) => {
  await signIn(page, /Ana \(cliente\)/);
  await expect(
    page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Inventario' }),
  ).toHaveCount(0);
  await page.goto('/catalog?category=notebook&price_lt=150000');
  const table = page.getByRole('table', { name: 'Resultados de catálogo' });
  await expect(table).toContainText('NB-DEV-16');
  await expect(table).toContainText('NB-DEV-32');
  await expect(table).not.toContainText('NB-DEV-32X');
  await expect(table).not.toContainText('NB-WS-64');
  await page.goto(`/orders/${ANA_ORDER}`);
  const packages = page.getByRole('list', { name: 'Paquetes' });
  await expect(packages.getByText('SIM-401-A')).toBeVisible();
  await expect(packages.getByText('SIM-401-B')).toBeVisible();
  await expect(packages.getByText('Envío simulado')).toHaveCount(2);
  await expect(packages.getByText(/Tracking desactualizado/).first()).toBeVisible();
  await expect(page.getByText(/Escalamiento requerido \(escalation\.v1\)/)).toBeVisible();
  // A foreign order is indistinguishable from a missing one.
  await page.goto(`/orders/${BEN_ORDER}`);
  await expect(page.locator('[data-state="not-found"]')).toBeVisible();
  await page.goto('/inventory');
  await expect(page.locator('[data-state="forbidden"]')).toBeVisible();
});

test('customer: streamed answer with evidence; a ticket exists only after an explicit click', async ({
  page,
}) => {
  await signIn(page, /Ana \(cliente\)/);
  const before = await db<{ n: number }>('SELECT count(*)::int AS n FROM commerce.tickets');
  await ask(page, `Mi pedido ${ANA_ORDER} está atrasado, ¿qué pasa?`);
  await expect(page.locator('[data-run-status="COMPLETED"]')).toBeVisible();
  await expect(page.getByText('Respuesta con evidencia')).toBeVisible();
  await expect(page.getByText('Redacción por plantilla (SIMULATED)')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Hallazgos order' })).toContainText(
    '[shipment: shipment:',
  );
  await expect(page.getByTestId('run-summary')).not.toContainText(/razonamiento|chain.of.thought/i);
  expect(await db<{ n: number }>('SELECT count(*)::int AS n FROM commerce.tickets')).toEqual(
    before,
  );
  await page.getByRole('button', { name: 'Crear ticket de soporte con esta evidencia' }).click();
  await expect(page.getByText(/Ticket creado/)).toBeVisible();
  const after = await db<{ n: number }>('SELECT count(*)::int AS n FROM commerce.tickets');
  expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
});

test('cancellation: proposal, user confirmation, approver decision, shown as requested not cancelled', async ({
  browser,
}) => {
  const ben = await newUser(browser, /Ben \(cliente\)/);
  await ask(ben, `Quiero solicitar la cancelación del pedido ${BEN_ORDER}`);
  await expect(ben.locator('[data-run-status="WAITING_HUMAN"]')).toBeVisible();
  await expect(ben.getByRole('region', { name: 'Propuesta de acción' })).toContainText(
    'CANCELLATION_REQUESTED',
  );
  await ben.getByRole('button', { name: 'Confirmar solicitud de cancelación' }).click();
  await expect(ben.getByText(/pendiente de aprobación por otra persona/)).toBeVisible();

  const approver = await newUser(browser, /Aprobador Acme/);
  await approver.goto('/approvals');
  const card = approver.getByRole('article').filter({ hasText: BEN_ORDER });
  await expect(card).toContainText('Pendiente de aprobación');
  await expect(card).toContainText('"expected_version":1');
  await expect(card).toContainText('Vence');
  await card.getByRole('button', { name: 'Aprobar' }).click();
  await expect(card.getByText(/Aprobada\. La ejecución la realiza el run/)).toBeVisible();

  await expect(ben.locator('[data-outcome="ACTION_EXECUTED"]')).toBeVisible({ timeout: 30_000 });
  await expect(ben.getByTestId('run-summary')).toContainText('Cancelación solicitada');
  await expect(ben.getByTestId('run-summary')).not.toContainText(
    /pedido cancelado|orden cancelada/i,
  );
  expect(
    await db('SELECT status, version FROM commerce.orders WHERE id = $1', [BEN_ORDER]),
  ).toEqual([{ status: 'CANCELLATION_REQUESTED', version: 2 }]);
});

test('approver: a request whose order changed after opening the screen shows the server conflict', async ({
  browser,
}) => {
  const orderId = randomUUID();
  await db(
    `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
     VALUES ($1, $2, $3, 'CONFIRMED', 'USD', 2900, 0, 0, 2900)`,
    [ACME, orderId, BEN],
  );
  const ben = await newUser(browser, /Ben \(cliente\)/);
  const created = await ben.request.post('/api/action-requests', {
    headers: { 'idempotency-key': `e2e-${orderId}`, origin: 'http://127.0.0.1:3100' },
    data: { order_id: orderId, reason_code: 'customer_request', expected_version: 1 },
  });
  expect(created.status()).toBe(201);
  const approver = await newUser(browser, /Aprobador Acme/);
  await approver.goto('/approvals');
  const card = approver.getByRole('article').filter({ hasText: orderId });
  await expect(card.getByRole('button', { name: 'Aprobar' })).toBeVisible();
  await db('UPDATE commerce.orders SET version = 2 WHERE id = $1', [orderId]);
  await card.getByRole('button', { name: 'Aprobar' }).click();
  await expect(card.locator('[data-decision-result="err"]')).toContainText('CONFLICT');
  await expect(card.locator('[data-decision-result="err"]')).toContainText('No se ejecutó nada');
  expect(await db('SELECT status, version FROM commerce.orders WHERE id = $1', [orderId])).toEqual([
    { status: 'CONFIRMED', version: 2 },
  ]);
});

test('inventory operator: balances and alerts, no customer data and no approval functions', async ({
  page,
}) => {
  await signIn(page, /Inventario Acme/);
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav.getByRole('link', { name: 'Aprobaciones' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Órdenes' })).toHaveCount(0);
  await page.goto('/inventory');
  await expect(page.getByRole('table', { name: 'Alertas' })).toContainText('critical_stock');
  await expect(page.getByRole('table', { name: 'Balances' })).toContainText(
    '00000000-0000-4000-8000-000000000112',
  );
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\b(Ana|Ben|Cara)\b|@[a-z0-9.-]+\.[a-z]{2,}/);
  await page.goto('/approvals');
  await expect(page.locator('[data-state="forbidden"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);
  await page.goto(`/orders/${ANA_ORDER}`);
  await expect(
    page.locator('[data-state="forbidden"], [data-state="not-found"]').first(),
  ).toBeVisible();
});

test('reconnection: reloading a run replays persisted events and never starts another run', async ({
  page,
}) => {
  await signIn(page, /Ana \(cliente\)/);
  const runId = await ask(page, 'Recomiéndame una notebook de desarrollo por menos de USD 1.500');
  await expect(page.locator('[data-run-status="COMPLETED"]')).toBeVisible();
  const runs = await db<{ n: number }>('SELECT count(*)::int AS n FROM commerce.agent_runs');
  await page.reload();
  await expect(page.locator('[data-run-status="COMPLETED"]')).toBeVisible();
  await expect(page.getByTestId('run-summary')).toContainText('NB-DEV-32');
  // Simulate a dropped connection: the browser goes offline and back while following a run.
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByTestId('run-summary')).toContainText('NB-DEV-32');
  expect(await db<{ n: number }>('SELECT count(*)::int AS n FROM commerce.agent_runs')).toEqual(
    runs,
  );
});

test('keyboard only: sign in, ask, and read the answer', async ({ page }) => {
  await page.goto('/login');
  const button = page.getByRole('button', { name: /Ana \(cliente\)/ });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Consola operacional' })).toBeVisible();
  await page.goto('/runs');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Consulta', exact: true }).focus();
  await page.keyboard.type('Mi pedido no llega');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Enviar' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Necesito una aclaración')).toBeVisible();
});

test('states: empty results, pending run, and a degraded console when the API is down', async ({
  page,
  browser,
}) => {
  await signIn(page, /Ana \(cliente\)/);
  await page.goto('/catalog?category=notebook&price_lt=1000&ram_gb=64');
  await expect(page.locator('[data-state="empty"]')).toContainText('No se relajan las condiciones');
  const context = await browser.newContext({ baseURL: DEGRADED_URL });
  const degraded = await context.newPage();
  await signIn(degraded, /Ana \(cliente\)/, DEGRADED_URL);
  await degraded.goto(`${DEGRADED_URL}/catalog`);
  await expect(degraded.locator('[data-state="degraded"]')).toContainText('Servicio degradado');
  await degraded.goto(`${DEGRADED_URL}/orders/${ANA_ORDER}`);
  await expect(degraded.locator('[data-state="degraded"]').first()).toBeVisible();
});
