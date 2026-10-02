## Why

M10 se cerró con una excepción aceptada (2026-10-01): las 300 etiquetas de `ops-eval@1.0.0` son de un solo autor, y [rag-evals.md](../../../docs/rag-evals.md) pide adjudicación por dos revisores. Este change separa ese punto abierto: deja listos el protocolo y las herramientas, y la revisión queda para una segunda persona.

## What Changes

- Protocolo de revisión ciega, cálculo de acuerdo y adjudicación (design.md).
- Herramientas: `pnpm --filter @commerce/evals run adjudication sheet|compare <dev|holdout> <reviewer-id>` genera hojas ciegas (sólo entradas, sin etiquetas del autor) y compara campo por campo con acuerdo observado y κ de Cohen, listando cada desacuerdo.
- Hojas ciegas de dev (180) y holdout (120) generadas para `reviewer-2` en `evals/adjudication/ops-eval-1.0.0/`.

Fuera de alcance: completar la revisión (requiere una segunda persona), cambiar etiquetas sin adjudicar y reutilizar el holdout actual para decidir (ya fue observado).

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `evaluation-observability`: se agrega el requisito de adjudicación de etiquetas por dos revisores con acuerdo medido.

## Impact

`evals/src/adjudication.ts`, `evals/src/adjudication-cli.ts`, `evals/test/adjudication.test.ts`, `evals/adjudication/`. Cuando la revisión termine, las etiquetas adjudicadas se publican como `ops-eval@1.1.0` con un holdout nuevo y se repite `pnpm evals:release`.
