## 1. M11 — Deployment/demo
- [ ] 1.1 Fijar región/OIDC/presupuesto y verificar compatibilidad cloud; implementar IaC/CI/TLS/secretos y datos privados (evaluation-observability).
  - Hecho localmente: imágenes inmutables, TLS en el borde, secretos como archivos, red de datos privada (`infra/compose.prod.yaml`), Terraform AWS y `deploy.yml` escritos. **Pendiente:** región, OIDC y presupuesto no fijados; IaC no aplicado ni validado; el despliegue espera autorización del dueño del repo y un host de costo cero.
- [x] 1.2 Ejecutar smoke, rollback, reconstrucción de cola y backup/restore aislado; guardar tiempos observados (evaluation-observability).
  - En el stack production-like local (`pnpm prod:drill`, 21/21); no en cloud.
- [x] 1.3 Publicar runbook y demo de tres casos más aprobación/replay con datos sintéticos (todas las capabilities).
  - `docs/runbook.md`; `pnpm prod:demo` 18/18 sobre TLS local.

## 2. Verification y cierre
- [x] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [ ] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
  - No archivado mientras 1.1 siga abierta.
