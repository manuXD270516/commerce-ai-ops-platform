## Context

Milestone M11. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §5. Operación en [runbook.md](../../../docs/runbook.md).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M11: Smoke con 3 casos, rollback y restart; restauración ensayada; costo/latencia etiquetados. No objetivos: Kubernetes, datos reales de clientes y SLA no medidos.

## Decisions

1. **Dos niveles de despliegue.** Un stack *production-like* local (`infra/compose.prod.yaml`) que se ejecuta y se mide, y la topología cloud (AWS) como IaC revisada pero no aplicada. Crear recursos cloud requiere autorización del dueño del repo, región, presupuesto y un host; el entorno de trabajo no tiene nada de eso y GitHub Actions está bloqueado por billing.
2. **Imágenes inmutables.** Un `infra/docker/Dockerfile` multi-target (api, worker, mcp, web, migrate) desde `node:22.23.1-bookworm` y el lockfile congelado; tag = commit. Corren como `node`, configuración sólo por entorno. Las imágenes de terceros se pinnean por versión y digest.
3. **Secretos como archivos.** `pnpm prod:secrets` genera credenciales nuevas en `.local/prod/` (git-ignored) y Compose las monta; el entrypoint convierte `*_FILE` en variables del proceso. En ECS, Secrets Manager inyecta valores y el mismo entrypoint escribe las claves JWK a archivos privados.
4. **Borde TLS y redes.** Caddy termina TLS (CA interna local; ACM + ALB en cloud) con HSTS/nosniff/frame deny y enruta sólo `/v1/*` y `/healthz` a la API y el resto a la consola. MCP, worker, PostgreSQL y Redis quedan en una red `internal` sin puertos publicados. La cookie de sesión es `Secure` detrás del proxy.
5. **Migraciones y seed.** Job `migrate` forward-only antes de las apps; el seed sintético sólo corre sobre una base vacía (`seed --if-empty`). El primer ensayo mostró que el job se re-ejecuta en cada `compose start` de un dependiente y que el seed reseteaba los datos; se corrigió y el drill ahora verifica que ningún ensayo pierde estado.
6. **Recuperación desde PostgreSQL.** Redis sin persistencia; el dispatch a la cola es best-effort (timeout 1,5 s) porque el run ya es durable; el worker re-registra schedulers y dispara el sweep al reconectar. Rate limits de escritura en PostgreSQL.
7. **Ensayos automatizados.** `pnpm prod:demo` (3 casos + aprobación + replay sólo vía TLS) y `pnpm prod:drill` (redis, restart, rollback con imagen rota, backup/restore aislado) escriben reportes MEASURED con tiempos de una sola observación, etiquetados como no-SLA.
8. **Cloud propuesto.** Terraform AWS: VPC privada, ECS Fargate con circuit breaker y rollback, RDS PostgreSQL 17 (pgvector), ElastiCache sin snapshots, Secrets Manager, ECR inmutable, ALB TLS 1.3, budget al 80 %. `deploy.yml` sólo `workflow_dispatch`, OIDC, inerte sin `DEPLOY_ENABLED`. Costo: no es cero (NAT, ALB, RDS, ElastiCache); no se estimó con precios porque no hay región elegida.

## Open Questions

Región, presupuesto mensual, cuenta y proveedor OIDC; host de costo cero si se exige; evaluar Node 24 LTS y PostgreSQL 18 frente al servicio gestionado; validación de Terraform (no instalado aquí).
