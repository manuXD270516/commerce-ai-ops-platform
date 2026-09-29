## Why

La demo final debe ser reproducible en cloud con TLS, datos privados, secretos administrados, recuperación ensayada y datos sintéticos.

## What Changes

- Región, OIDC y presupuesto fijados; IaC, CI de despliegue, TLS y secretos.
- Smoke, rollback, reconstrucción de cola y backup/restore aislado con tiempos observados.
- Runbook y demo de los tres casos más aprobación y replay.

Fuera de alcance: Kubernetes, datos reales de clientes y SLA no medidos.

## Capabilities

### New Capabilities

- `evaluation-observability`: 1 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M11 (Deployment/demo) del [roadmap](../../../docs/roadmap.md); depende de M10. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 12.1–12.3, renumeradas como 1.x).
