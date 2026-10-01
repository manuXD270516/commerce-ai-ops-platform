## 1. M11 — Deployment/demo (destino AKS, alcance "listo para desplegar")
- [x] 1.1 Implementar IaC/CI/TLS/secretos y datos privados para AKS, parametrizados y sin aplicar; dejar región/OIDC/presupuesto como valores que provee el dueño (evaluation-observability).
  - `infra/terraform/azure` (fmt + validate OK), `infra/k8s` (kustomize + kubeconform OK), `.github/workflows/deploy.yml` (workflow_dispatch, OIDC, nunca ejecutado). Aplicar en Azure es un paso futuro con autorización explícita (decisión del dueño, 2026-10-01).
- [x] 1.2 Ejecutar smoke, rollback, reconstrucción de cola y backup/restore aislado; guardar tiempos observados (evaluation-observability).
  - Stack production-like local (`pnpm prod:drill`, 21/21) y rollout/undo en k3s (`pnpm k8s:local`).
- [x] 1.3 Publicar runbook y demo de tres casos más aprobación/replay con datos sintéticos (todas las capabilities).
  - `docs/runbook.md` (incluye el camino AKS); `pnpm prod:demo` 18/18 en Compose y la misma demo en k3s.
- [x] 1.4 Validar localmente y sin costo la configuración de AKS: Terraform, render y esquemas de manifiestos, y despliegue en un cluster Kubernetes local con la demo (evaluation-observability).

## 2. Verification y cierre
- [x] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [x] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
