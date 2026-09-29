# Verification

## Estado

M2 completado (tareas 1.1, 1.2 y 2.1). Sin búsqueda semántica (M4), órdenes transaccionales (M3) ni vistas de consola funcionales (M9).

Gate de salida (roadmap): OpenAPI/contract tests; presupuesto estricto, moneda y paginación determinista.

## Resultados M2 (2026-09-29)

Entorno: Windows 11 x64, Node 22.23.1, pnpm 12.4.2, PostgreSQL 17 + pgvector y Redis vía Compose; fixture `commerce-domain` 0.2.0 (sha256 `0698ba4ab58764d2e67d6745cd7f0f639ed57cc430de82f07c82e4289cec0091`).

- `pnpm test` (en serie): 95 tests, 0 fallos. De ellos, M2: `apps/api/test/catalog.test.ts` (19), `packages/contracts/test/identity.test.ts` (4) y 4 tests de `packages/domain/test/ops.test.ts`.
- `pnpm contracts:check`: Redocly válido (0 errores) y tipos generados sin drift.
- Smoke local: 14/14, incluida la consola web → API con token firmado.
- Lint, formato, typecheck y build limpios.

| Verificación | Resultado | Evidencia |
|---|---|---|
| Frontera estricta USD 1.500 | MEASURED | `price_lt=150000` devuelve `NB-DEV-16` y `NB-DEV-32` y excluye `NB-DEV-32X` (150000) y `NB-WS-64`; con 150001 sí aparece `NB-DEV-32X` |
| Moneda | MEASURED | `currency=EUR` da 400 `VALIDATION_ERROR`; todos los ítems son `currency: USD` |
| Paginación determinista | MEASURED | Recorrer con `limit=1` y `limit=2` reproduce exactamente el listado completo ordenado por `(price_minor, sku_code)` |
| Filtros inválidos | MEASURED | 11 casos dan 400 con `error.schema.json`: `limit` 0/51, `price_lt` abc/1.5/-1, `tenant_id`, parámetro repetido, cursor inválido y UUIDs mal formados |
| Contratos | MEASURED | Ajv valida `productList`, `inventory` y `error` en cada respuesta del test |
| Identidad | MEASURED | Sin token, token de otra clave o token de audiencia MCP: 401. Token válido sin membership en el tenant: 403. `X-Tenant-Id` ajeno se ignora. Firma alterada, issuer distinto, token expirado o vida mayor de 1 h: rechazados |
| Datos ocultos por rol | MEASURED | Borrador y producto de Globex dan 404 para Ana; customer sólo ve `available`; inventory ve `on_hand=12, reserved=1, safety_stock=5`; el borrador sólo es visible para inventory |

## Trazabilidad de escenarios

| Escenario | Evidencia |
|---|---|
| Strict budget | `catalog.test.ts` “applies the strict USD 1500 budget…”; `ops.test.ts` “excludes a SKU priced exactly USD 1500…” y “applies a strict USD 1500 notebook budget…”; smoke “web catalog … price_minor < 150000” |
