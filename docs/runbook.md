# Runbook

Operación del MVP en el entorno **production-like local** (`infra/compose.prod.yaml`) y plan para la demo cloud. Todo lo marcado como observado salió de los scripts del repo en una sola estación de trabajo (Windows 11 + Docker Desktop); son observaciones puntuales, **no SLA**. La demo cloud no está desplegada: ver [§ Cloud](#cloud-pendiente-de-autorización).

## 1. Topología production-like

| Servicio | Imagen | Red | Expuesto |
|---|---|---|---|
| `edge` (Caddy 2.11.4) | pinneada por digest | `edge` | `127.0.0.1:${PROD_HTTPS_PORT:-8443}` → 443, TLS con CA interna de Caddy |
| `web` (Next.js) | `commerce-ai-ops/web:${IMAGE_TAG}` | `edge` | sólo vía edge |
| `api` (NestJS) | `commerce-ai-ops/api:${IMAGE_TAG}` | `edge`, `data` | `/v1/*` y `/healthz` vía edge |
| `worker` (BullMQ) | `commerce-ai-ops/worker:${IMAGE_TAG}` | `data` | no |
| `mcp` | `commerce-ai-ops/mcp:${IMAGE_TAG}` | `data` | no (clientes MCP dentro de la red privada) |
| `migrate` (job) | `commerce-ai-ops/migrate:${IMAGE_TAG}` | `data` | no |
| `postgres` (pgvector pg17), `redis` | pinneadas por digest | `data` (`internal: true`) | no |

- Imágenes inmutables: un único `infra/docker/Dockerfile` multi-target; el tag es el commit (`IMAGE_TAG`). Configuración por entorno, nunca en la imagen.
- Secretos: `pnpm prod:secrets` genera en `.local/prod/` (ignorado por git) contraseñas aleatorias, URLs, clave PII y un par de claves del emisor nuevo. Se montan como Compose secrets; `infra/docker/entrypoint.sh` convierte `*_FILE` en variables sólo dentro del proceso. Nada se reutiliza del `.env` de desarrollo.
- Redis sólo coordina (sin persistencia, a propósito). PostgreSQL es la fuente de verdad de runs, aprobaciones, outbox y auditoría.
- Proveedor de IA: plantilla determinística (`TemplateSynthesizer`, etiquetado SIMULATED). No hay llamadas a LLM ni embeddings pagos.

## 2. Operación diaria

```powershell
pnpm install; pnpm build            # el host firma tokens de demo con packages/contracts/dist
pnpm prod:secrets                   # una vez (rotación: --force y recrear el stack)
pnpm prod:up                        # build + migrate + seed + healthchecks (--wait)
pnpm prod:demo                      # 3 casos + aprobación + replay, sólo a través de TLS
pnpm prod:drill                     # redis | restart | rollback | restore (todos por defecto)
pnpm prod:down                      # conserva volúmenes; `docker compose -f infra/compose.prod.yaml down -v` los borra
```

Puerto ocupado: `PROD_HTTPS_PORT=9443 pnpm prod:up` (y la misma variable para demo/drill). No detener contenedores de otros proyectos.

Health: `/healthz` (liveness) y `/readyz` (PostgreSQL, pgvector, Redis) en API; `/readyz` del worker (Redis, PostgreSQL) sólo dentro de la red. Logs JSON con `correlation_id` y `trace_id`: `docker compose -f infra/compose.prod.yaml logs -f api worker`.

## 3. Migraciones

Forward-only (`packages/domain/migrations/NNNN_*.sql`), aplicadas por el job `migrate` con el rol `commerce_migrator` antes de que arranquen api/worker/mcp (`service_completed_successfully`). Un rollback de aplicación **no** revierte el schema: cada migración debe ser compatible con la versión anterior de la app (expand/contract). El job también ejecuta el seed sintético (idempotente).

## 4. Rollback

Redeploy del tag anterior (inmutable): `IMAGE_TAG=<tag-anterior> docker compose -f infra/compose.prod.yaml up -d --no-build --wait api worker web mcp`. El healthcheck (`--wait`) es el gate: un release que no llega a ready no se da por desplegado. En cloud, ECS hace lo mismo con el deployment circuit breaker (`rollback = true`). Ensayo: `pnpm prod:drill rollback` despliega una imagen de API rota a propósito, verifica que el gate la rechaza y vuelve al tag bueno.

## 5. Pérdida de Redis

Síntoma: `/readyz` con `redis=down`; runs nuevos quedan `QUEUED`; aprobaciones quedan registradas pero el run no avanza.

1. No hace falta intervenir datos: la API sigue aceptando runs y decisiones (el dispatch a la cola es best-effort con timeout de 1,5 s; el run ya es durable en PostgreSQL).
2. Al volver Redis el worker re-registra sus schedulers (log `redis reconnected`) y dispara el sweep de recuperación, que reconstruye desde PostgreSQL los runs `QUEUED`, los `RUNNING` con lease vencido y los `WAITING_HUMAN` con decisión. Los leases y la ejecución idempotente impiden doble efecto.
3. Los rate limits de escritura (tickets por sujeto/hora) están en PostgreSQL y siguen aplicando durante el corte.

Ensayo: `pnpm prod:drill redis`.

## 6. Backup y restore

Backup lógico: `docker compose -f infra/compose.prod.yaml exec -T postgres pg_dump -U commerce_admin -Fc commerce > backup.dump`. Para un snapshot comparable se pausa el worker (único escritor en segundo plano). El ensayo `pnpm prod:drill restore` lo automatiza: dump, restore en un PostgreSQL aislado (`infra/restore-compose.yaml`, red interna, sin puerto publicado), creación previa de los roles de la app como `NOLOGIN`, y verificación de conteos por tabla, estado de runs, último evento de auditoría, FKs validadas sin huérfanos, políticas RLS y migraciones aplicadas. El dump queda en `.local/prod/backups/` con su `*.verify.json`. En cloud el equivalente es snapshot de RDS + restore a instancia aislada (no ensayado).

## 7. Retención

`pnpm db:retention` (o `node dist/cli.js retention` en la imagen `migrate`) ejecuta `commerce.apply_retention(now())`: borra estado de runs > 30 días y el texto libre del usuario, consentimientos e idempotencia > 30 días; requests/aprobaciones/ejecuciones/auditoría decididas > 90 días. Programarlo diario (cron del host o tarea programada de ECS); no está programado en el stack local.

## 8. Calidad y carga

- `pnpm verify`: lint, formato, typecheck, build, tests, contratos y evals de desarrollo.
- `pnpm evals:release`: holdout ×3, gates de `evals/gates/gates.v0.json`; sale con 1 si un gate falla.
- `pnpm load`: 5 min de warm-up + 15 min con 10 sesiones contra los builds locales (latencia de lectura y alertas MEASURED; latencia/tokens del workflow con proveedor SIMULATED).

## 9. Tiempos observados

Última ejecución (2026-10-01, una observación cada uno; detalle en `openspec/changes/add-cloud-deployment-demo/verification.md`). No son SLA.

| Operación | Observado |
|---|---|
| Build de las 5 imágenes (en frío) / `prod:up` con imágenes listas | 238 s / 12 s |
| Run de demo de extremo a extremo (3 casos) | 0,44–1,26 s |
| Aceptar un run con Redis caído | 1,5 s (timeout de dispatch) |
| Recuperación de trabajo tras volver Redis | 1,3 s |
| Restart api + worker hasta ready | 4,6 s |
| Rollback: detectar release rota / volver al tag anterior | 2,7 s / 4,7 s |
| Backup (pg_dump, 187 KiB) / restore aislado completo | 0,46 s / 4,9 s |

## Cloud (pendiente de autorización)

`infra/terraform/aws` describe la topología de [architecture.md §5](architecture.md): VPC con subredes privadas, ECS Fargate (api, worker, mcp, web), RDS PostgreSQL 17 con pgvector, ElastiCache sin snapshots, Secrets Manager, ECR inmutable, ALB con TLS 1.3 y el mismo ruteo que el Caddyfile, budget con alerta al 80 %. `.github/workflows/deploy.yml` (sólo `workflow_dispatch`, OIDC sin claves guardadas) queda inerte hasta `DEPLOY_ENABLED=true`.

**Estado: no aplicado, no validado con `terraform validate` (Terraform no está instalado en esta máquina) y nunca ejecutado.** Antes de aplicar hace falta decisión del dueño del repo sobre:

1. Región (con RDS PostgreSQL 17 + pgvector ≥ 0.8, Fargate y ElastiCache) y cuenta.
2. Presupuesto mensual y destinatarios de alertas; la topología propuesta (NAT, ALB, RDS, ElastiCache) **no es gratuita**. Si se exige costo cero, hace falta otro host.
3. Proveedor OIDC/rol IAM para GitHub Actions (hoy bloqueado por billing) y certificado ACM/dominio.
4. Emisor de identidad real: el sign-in de demo de la consola no es un IdP de producción.
