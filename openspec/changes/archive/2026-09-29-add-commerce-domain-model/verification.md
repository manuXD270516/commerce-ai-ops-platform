# Verification

## Estado de esta entrega

Fase: M1 completado (tareas 1.1–1.3 y 2.1). Sin APIs públicas (M2), reservas/detector (M3), embeddings (M4) ni tools MCP (M5).

Gate de salida (roadmap): Migración limpia; invariantes, FKs y aislamiento negativos; snapshots consistentes.

## Resultados M1 (2026-09-29)

Entorno: Windows 11 x64, Node 22.23.1, pnpm 12.4.2, PostgreSQL 17 + pgvector vía Compose (`infra/compose.yaml`). `pnpm --filter @commerce/domain test`: 3 archivos, **29 tests, 0 fallos**. Evidencia de M1: los 11 tests de `test/persistence.test.ts` y 2 de `test/domain.test.ts` (PII, hash de idempotencia); `test/ops.test.ts` pertenece a M2–M8 y se reporta en sus changes.

Migraciones de M1: `0001_schema.sql`, `0002_rls.sql`; `0003_embeddings.sql` (columna `embedding`) es de M4. `commerce_runtime.rolbypassrls = false`. CI de GitHub en verde para M0 (run 36530841633, jobs `checks` y `smoke`).

| Verificación | Resultado | Evidencia |
|---|---|---|
| Migración en BD vacía | MEASURED | `test/persistence.test.ts` “migrates an empty database…”; `pnpm db:migrate` aplica todas las migraciones pendientes |
| Snapshots inmutables | MEASURED | UPDATE de `order_items.title_snapshot` rechazado (`immutable`); Ana ve `Notebook de desarrollo 16GB` y `totalMinor=132800` |
| Orden ajena mismo tenant | MEASURED | Ana → orden de Ben: `DomainError NOT_FOUND`; `audit_events.outcome=DENIED` (commit independiente del throw) |
| ID cruzado de tenant | MEASURED | Ana → orden de Cara (Globex): `NOT_FOUND`; INSERT de orden Acme con `customer_id` de Cara: FK |
| Pool sin fugas de contexto | MEASURED | Tras COMMIT, `SET LOCAL` se limpia y `SELECT count(*) FROM orders` = 0 en la misma conexión |
| Idempotencia | MEASURED | `recordProbe` con la misma clave/payload reutiliza `eventId`; payload mutado → `CONFLICT` |
| Rollback de UoW | MEASURED | throw tras `appendOutbox` deja 0 filas en `outbox` |

Fixture `evals/fixtures/commerce-domain/0.1.0` (sha256 `4d6b71cd639c972ff4613c90f7f158a6cc2ef87a84b0795c06cf0b2abb4c3333`). Decisiones en design.md; RLS sin FORCE para que el owner/migrator pueda sembrar, runtime sin BYPASSRLS.

## Trazabilidad de escenarios

| Escenario | Evidencia |
|---|---|
| Customer requests another customer's order | `persistence.test.ts` “hides Ben’s order from Ana…” |
| Cross-tenant identifier | `persistence.test.ts` “hides Globex orders…” y “rejects a cross-tenant foreign key…” |
