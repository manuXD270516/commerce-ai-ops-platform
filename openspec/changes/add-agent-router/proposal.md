## Why

Los workflows necesitan un proveedor elegido por evaluación, un router determinístico con clasificador acotado y ejecución durable con presupuestos.

## What Changes

- Comparación de proveedores/modelos con el mismo dataset y registro de versiones.
- Router determinístico + clasificador estructurado con aclaraciones.
- Grafo LangGraph JS con checkpoints en PostgreSQL, presupuestos, cancelación y reanudación autorizada.

Fuera de alcance: Especialistas completos (M7) y efectos privilegiados (M8).

## Capabilities

### New Capabilities

- `agent-workflows`: 2 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M6 (Agent router) del [roadmap](../../../docs/roadmap.md); depende de M5. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 7.1–7.3, renumeradas como 1.x).
