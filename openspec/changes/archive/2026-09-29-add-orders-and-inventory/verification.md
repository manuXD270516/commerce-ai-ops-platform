# Verification

## Estado

Completo. Todas las evidencias son MEASURED contra PostgreSQL 17 y Redis de Compose locales, el 2026-09-29. El tracking y los paquetes son simulados (`source_mode = simulated`); no hay transportistas reales en M3.

## Evidencia exigida

Gate de salida (roadmap): Concurrencia/idempotencia; paquetes parciales; 4 reglas con fixtures y freshness.

Evidencia por capability: Competencia por la última unidad, eventos duplicados, envíos parciales y stale, baja historia y demanda cero, contra PostgreSQL real.

## Resultados

Comandos: `pnpm verify` (lint, format, typecheck, build, tests, contratos, evals) en verde con 103 tests; `pnpm smoke` 15/15, repetido dos veces seguidas.

| Escenario | Evidencia |
| --- | --- |
| Concurrent reservation | `packages/domain/test/orders-inventory.test.ts` "lets exactly one of two concurrent reservations take the last units": una reserva confirma, la otra devuelve CONFLICT; `reserved = 2`, un solo movimiento `reserve`, una reserva ACTIVE. "replays a retried reservation…" cubre el retry con la misma clave de idempotencia. |
| Duplicate inventory event | "keeps a single stock effect and movement for a duplicated event_id": dos entregas concurrentes del mismo `event_id` dejan un único movimiento y +5 en `on_hand`. "rejects movements that would break on_hand >= reserved >= 0…": sin movimiento ni inbox tras el rechazo. |
| Partial shipment | "identifies lines and package states of a partial shipment…" (SIM-401-A fresco, SIM-401-B stale, línea 411 en A, orden no entregada) y "applies out-of-order tracking…" (A DELIVERED, B DELAYED, un evento viejo no retrocede el estado, replay ignorado, transportista distinto rechazado, orden no entregada). |
| Critical stock and discrepancy | "records critical stock and a current count discrepancy without adjusting the balance": NB-DEV-32 recibe critical_stock y discrepancy (conteo 1 contra on_hand 4) y el balance queda igual. "ignores stock counts older than 72 hours". |
| Insufficient historical demand | "reports INSUFFICIENT_DATA for zero demand and too few demand days…": NB-DEV-32X `zero_demand`, NB-DEV-16 `few_demand_days`, sin Infinity/NaN. "computes stockout risk from 7-day average demand…": MOUSE, demanda diaria 6.429. |
| Repeated anomaly job | "does not duplicate alerts when the job repeats or runs concurrently in the same window" (repetición y dos corridas concurrentes, cero grupos duplicados en la tabla). "flags an unusual order only with >= 20 observations…": umbral estricto, órdenes fuera de 7 días ignoradas y una sola alerta por línea de orden en ventanas posteriores. `apps/worker/test/anomaly-job.test.ts`: el barrido recorre los 2 tenants con `service:anomaly-detector` y no crea nada al repetirse. Smoke: el worker compilado ejecuta el job `inventory-anomalies` contra la BD. |

Los permisos también se prueban: un customer recibe FORBIDDEN al mover stock o ejecutar el detector.

## Límites

- La latencia de alerta (<5 min 30 s en rag-evals.md) sigue EXPECTED: el job corre cada 5 minutos, pero no se midió el tiempo de extremo a extremo.
- GitHub Actions no arranca jobs por un problema de facturación de la cuenta; la verificación de este milestone es local con los mismos comandos que CI.
