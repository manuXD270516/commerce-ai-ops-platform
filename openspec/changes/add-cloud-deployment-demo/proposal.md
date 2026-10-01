## Why

La demo final debe ser reproducible, con TLS, datos privados, secretos administrados, recuperación ensayada y datos sintéticos, y quedar lista para desplegarse en cloud sin depender de decisiones que sólo puede tomar el dueño del repositorio.

## What Changes

- Stack production-like local (Compose) con imágenes inmutables, TLS en el borde, secretos como archivos y red de datos privada; smoke, rollback, reconstrucción de cola y backup/restore aislado con tiempos observados.
- **Destino cloud: Azure Kubernetes Service (decisión del dueño del repo, 2026-10-01), con alcance "listo para desplegar":** Terraform `azurerm` parametrizado (AKS, ACR, PostgreSQL Flexible Server con pgvector, Azure Cache for Redis, Key Vault con driver CSI, red privada, workload identity y federación OIDC para GitHub, budget), manifiestos Kubernetes (Kustomize) y workflow de despliegue manual. Validación sólo local y gratuita: `terraform fmt/validate`, render y validación de esquemas, y despliegue en un cluster k3s local con la demo.
- Runbook y demo de los tres casos más aprobación y replay.

Fuera de alcance: aplicar la IaC o desplegar en Azure (paso futuro que requiere autorización explícita, suscripción, región, presupuesto, DNS/TLS y credencial federada), datos reales de clientes y SLA no medidos. Sustituye el plan previo en AWS, que se retiró del repositorio.

## Capabilities

### New Capabilities

- `evaluation-observability`: 1 requisito de este milestone (despliegue resiliente, listo para AKS).

### Modified Capabilities

Ninguna.

## Impact

Milestone M11 (Deployment/demo) del [roadmap](../../../docs/roadmap.md); depende de M10. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp` y se re-alcanzó el 2026-10-01 al cambiar el destino a AKS.
