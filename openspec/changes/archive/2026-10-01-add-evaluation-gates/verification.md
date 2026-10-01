# Verification

## Estado

Implementado y medido (2026-10-01, commit `c3cec67`). La evaluación de release **falla dos gates de calidad** sobre el holdout; ningún gate de seguridad falló. Archivado con excepciones aceptadas.

## Excepciones aceptadas

Decisión del dueño del repo (2026-10-01), registrada en design.md (decisión 9): se acepta esta corrida como resultado honesto, sin cambiar valores ni umbrales.

| Excepción | Medido | Gate | Siguiente paso |
|---|---|---|---|
| `intent_routing_macro_f1` (holdout) | 0,936 | ≥ 0,95 | nuevo ciclo de ajuste en dev y holdout nuevo |
| `retrieval_mrr_at_5` (holdout) | 0,792 | ≥ 0,8 | ídem |
| Adjudicación de etiquetas por dos revisores | **no realizada** (punto abierto) | requerida por rag-evals.md | adjudicación humana antes de declarar gates cumplidos |

## Evidencia exigida

Gate de salida (roadmap): Reporte reproducible de diez métricas; todos los gates y limitaciones publicadas.

## Resultados

Reportes copiados en [`evidence/`](evidence/) (los de `evals/reports/` están ignorados por git). Entorno: Windows 11, Node 22.23.1, PostgreSQL 17 + pgvector y Redis en Docker Desktop; proveedor de síntesis `template-synth.v1` (SIMULATED, sin LLM).

### Release (`pnpm evals:release`, holdout ×3) — FAIL

[`release-gates-20261001T214637.md`](evidence/release-gates-20261001T214637.md). 19/21 gates pasan.

| Dimensión | Métrica (holdout) | Valor | Gate | Estado |
|---|---|---|---|---|
| Routing | intent_routing_macro_f1 | 0,936 (n=120; decisión de ruta 0,975) | ≥ 0,95 | **FAIL** — 6 adversariales off-topic/inyección |
| Tools | tool_selection_f1 / forbidden | 0,984 / 0 | ≥ 0,95 / 0 | pass |
| Relevancia | nDCG@3 / elegibles | 1,0 (n=24) / 56/56 | ≥ 0,85 / 1 | pass (rúbrica escrita conociendo las reglas) |
| Retrieval | Recall@5 / MRR@5 (knowledge holdout) | 0,917 / **0,792** (n=12) | ≥ 0,9 / ≥ 0,8 | **FAIL** MRR |
| Factualidad | soportados / inventos críticos | 246/246 (IC95 [0,985; 1]) / 0 | ≥ 0,98 / 0 | pass (verificación determinística, sin muestra humana) |
| Argumentos | schema / semántico | 187/187 / 128/128 | 1 / ≥ 0,98 | pass |
| No autorizados | efectos / lecturas | 0 / 0 (cota 95 % por caso 0,025) | 0 | pass |
| Escalamiento | recall / precisión | 16/16 / 16/16 (IC95 [0,806; 1]) | ≥ 0,95 / ≥ 0,9 | pass (n chico) |
| Latencia | API read p95 / alerta | 32,8 ms (n=121.384) / 276,8 s (n=3) | < 500 ms / < 330 s | pass, MEASURED |
| Latencia/tokens | workflow p95 / tokens p95 / max | 489 ms / 1.394 / 1.646 | < 12 s / ≤ 8.000 / ≤ 12.000 | pass, **SIMULATED** |
| Costo | cost_per_run | 0 USD | reporte | SIMULATED (sin proveedor) |

Los fallos no se corrigieron ajustando contra el holdout: el router y el retrieval quedaron fijados en dev (M4/M6) y corregirlos ahora contaminaría el holdout. Requieren un nuevo ciclo con holdout nuevo.

### Desarrollo (`pnpm verify`)

`ops-eval-dev` (180 casos ×3): 13/13 gates MEASURED pasan. Durante la primera corrida se encontraron y corrigieron dos defectos del harness, no del producto: factualidad verificada sobre la base de la última repetición (mostraba 229/334 falsos fallos de política retirada) — ahora se verifica cada repetición contra su propia base y se reporta la peor; y el patrón de tarjetas marcaba los UUID sintéticos de dígitos — ahora excluye UUID y exige Luhn (`evals/test/pii-audit.test.ts`).

### Carga (`pnpm load`, 5 + 15 min, 10 sesiones)

API en modo cola + worker reales, 500 SKUs / 100 docs / 1.000 órdenes / 5.000 movimientos extra: 142.541 requests, error 0, read p95 32,8 ms; alerta de stock crítico peor caso 276,8 s de 3 (barrido programado cada 5 min). Una sola máquina; no es SLA.

### Trazas, auditoría y PII

- Spans `agent.run` y `tool.call` en un mismo trace, sin texto de usuario ni argumentos: `packages/ai/test/tracing.test.ts`.
- `GET /v1/action-requests/:id/trail` (actor, aprobación, política/versión, ejecución con idempotencia, auditoría, evento): `apps/api/test/approvals.test.ts`.
- `pii-audit`: 0 hallazgos en run_events, auditoría, evidencia, idempotencia, outbox, tickets y checkpoints; emails sólo cifrados; logs del último smoke sin tokens ni cookies.
- Retención `0009_retention.sql`: `packages/domain/test/retention.test.ts`.
- Dashboard estático: [`ops-dashboard-20261001T214500.md`](evidence/ops-dashboard-20261001T214500.md).

### Tests

`pnpm verify` verde: 60 domain, 27 ai, 31 api, 6 worker, 17 contracts, 11 evals y el resto de paquetes.

## Limitaciones

- Etiquetas de un solo autor, sin adjudicación de dos revisores; sin muestra humana de factualidad (tarea 1.1).
- Holdout sellado de forma procedimental, no criptográfica.
- Latencia de workflow, tokens y costo sólo con proveedor simulado.
