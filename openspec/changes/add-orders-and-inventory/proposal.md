## Why

La investigación de órdenes y las alertas de inventario necesitan hechos consistentes: fulfillment por línea, tracking simulado con frescura, reservas atómicas y reglas determinísticas de anomalías.

## What Changes

- Órdenes, fulfillment y adaptador logístico simulado y etiquetado, con eventos fuera de orden.
- Reservas y movimientos atómicos, idempotentes y versionados.
- Detector determinístico de cuatro reglas con alertas deduplicadas.

Fuera de alcance: Transportistas reales, notificaciones externas, explicación de anomalías con LLM (M7) y solicitud de cancelación (M8).

## Capabilities

### New Capabilities

- `commerce-domain`: 2 requisito(s) de este milestone.
- `agent-workflows`: 1 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M3 (Orders and inventory) del [roadmap](../../../docs/roadmap.md); depende de M1, M2. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 4.1–4.3, renumeradas como 1.x).
