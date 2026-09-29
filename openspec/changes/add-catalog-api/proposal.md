## Why

Recomendaciones, consola y tools de catálogo dependen de una API REST tipada con filtros exactos de precio y moneda, disponibilidad por rol y región y paginación determinista.

## What Changes

- Contratos JSON Schema/OpenAPI v1 de productos, detalle y disponibilidad.
- Filtros tipados, cursores con máximo 50 elementos y errores estables.
- Visibilidad por rol y región sin datos ocultos.

Fuera de alcance: Búsqueda semántica (M4), órdenes e inventario transaccional (M3) y vistas de consola (M9).

## Capabilities

### New Capabilities

- `commerce-domain`: 1 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M2 (Catalog API) del [roadmap](../../../docs/roadmap.md); depende de M1. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 3.1–3.2, renumeradas como 1.x).
