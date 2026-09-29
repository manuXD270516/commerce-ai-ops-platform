## Context

Milestone M1. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §1 (bounded contexts), §4 (idempotencia y concurrencia) y §6 (decisión 7, persistencia); [modelo de datos](../../../docs/data-model.md).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M1: Migración limpia; invariantes, FKs y aislamiento negativos; snapshots consistentes. No objetivos: APIs públicas (M2), reservas y detector de anomalías (M3), embeddings (M4) y cualquier tool MCP (M5).

## Decisions

Ninguna cambia comportamiento ni alcance del MVP.

| # | Tema | Decisión | Justificación |
|---|---|---|---|
| 1 | Layout | SQL versionado en `packages/domain/migrations/`; runner `migrate()` en el mismo paquete; CLI `pnpm db:migrate` | El dominio posee el schema; las apps no emiten DDL |
| 2 | Roles | Tres roles: `commerce_local` (bootstrap, superusuario del contenedor), `commerce_migrator` (OWNER del schema `commerce`) y `commerce_runtime` (`NOBYPASSRLS`, sin ownership, DML acotado). Apps usan sólo `DATABASE_URL` (runtime). `DATABASE_ADMIN_URL` y `DATABASE_MIGRATOR_URL` son para migrate/seed | Cumple “migrator separado del runtime” y “runtime sin BYPASSRLS ni ownership” |
| 3 | Transacción | Toda operación de dominio corre en `withUnitOfWork`: `BEGIN`, `set_config(..., is_local=true)` para `app.tenant_id`, `app.subject_id`, `app.role`, `app.customer_id`, trabajo, `COMMIT`. El pool no conserva contexto entre clientes | `SET LOCAL` se limpia al terminar la transacción; un checkout posterior sin contexto ve cero filas por FORCE RLS |
| 4 | RLS | `ENABLE ROW LEVEL SECURITY` (sin `FORCE`) en tablas de negocio. Política de tenant: `tenant_id = current_setting('app.tenant_id', true)::uuid`. Política adicional en `orders`, `order_items`, `fulfillments`, `fulfillment_items`, `shipments`, `tracking_events` y `tickets`: un `customer` sólo ve filas de su `customer_id`. Tablas de catálogo/inventario/knowledge se filtran sólo por tenant. El migrator es OWNER y, sin FORCE, bypasea RLS para seed; `commerce_runtime` es `NOBYPASSRLS` y no es owner | El escenario de orden ajena en el mismo tenant no puede resolverse sólo con tenant_id; FORCE impediría al owner aplicar fixtures |
| 5 | Fixtures | Dataset versionado `evals/fixtures/commerce-domain/0.1.0/seed.json` + `manifest.json` con sha256. Dos tenants sintéticos `acme` y `globex`, USD, una región `us-east`. IDs estables. Se aplica con el migrator (bypass RLS) vía `pnpm db:seed` | Mismo patrón de integridad que el harness de M0; alimenta M2–M9 |
| 6 | PII | `customers.email_ciphertext` (AES-256-GCM) y `email_hash` (SHA-256 del email normalizado). Clave `PII_ENCRYPTION_KEY` de 32 bytes en hex, sólo en entorno, nunca en el repo | El modelo exige email cifrado; el hash permite unicidad sin texto claro |
| 7 | Embeddings | Tabla `chunks` sin columna vector. M4 la añade cuando el spike fije dimensión | Architecture.md: no mezclar espacios ni fijar dimensión antes del spike |
| 8 | Errores | `DomainError` con códigos estables `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `VALIDATION_ERROR`. `getOrder` para un customer ajeno o un ID de otro tenant devuelve `NOT_FOUND` y escribe `audit_events` con `outcome=DENIED` | Uniforme con §4; no confirma existencia |
| 9 | Primitivas M1 | `withUnitOfWork`, `commitIdempotent`, `appendOutbox`, `appendAudit`, `getOrder`, `getCustomer`. Las reservas atómicas y el detector de anomalías esperan a M3; las APIs REST a M2 | El requisito de este change es aislamiento y ownership, no el resto del dominio |

## Open Questions

Ninguna. Las tres pendientes del change quedan cerradas por las decisiones 1, 2 y 5.
