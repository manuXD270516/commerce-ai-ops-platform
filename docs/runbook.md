# Runbook

Operación del MVP en el entorno **production-like local** (`infra/compose.prod.yaml`) y plan para la demo cloud. Todo lo marcado como observado salió de los scripts del repo en una sola estación de trabajo (Windows 11 + Docker Desktop); son observaciones puntuales, **no SLA**. El destino cloud es AKS, **listo para desplegar pero no desplegado**: ver [§ AKS](#aks-listo-para-desplegar-pendiente-de-autorización).

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
- Secretos: `pnpm prod:secrets` genera en `.local/prod/` (ignorado por git) contraseñas aleatorias, URLs, clave PII y un par de claves del emisor nuevo. Se montan como Compose secrets; `infra/docker/entrypoint.sh` convierte `*_FILE` en variables sólo dentro del proceso. Nada se reutiliza del `.env` de desarrollo. Como Compose (sin swarm) monta cada archivo tal cual y las apps corren como `node` (uid 1000), los archivos son legibles (0444) dentro de un directorio 0700 que ningún otro usuario del host puede recorrer; con 0600 el job `migrate` fallaba en los runners de GitHub (uid 1001).
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

Redeploy del tag anterior (inmutable): `IMAGE_TAG=<tag-anterior> docker compose -f infra/compose.prod.yaml up -d --no-build --wait api worker web mcp`. El healthcheck (`--wait`) es el gate: un release que no llega a ready no se da por desplegado. En Kubernetes, `maxUnavailable: 0` mantiene los pods anteriores mientras un release no pasa readiness y `kubectl -n commerce rollout undo deployment/<app>` vuelve a la revisión previa (el workflow de AKS lo hace solo si un rollout falla; ensayado en `pnpm k8s:local`). Ensayo: `pnpm prod:drill rollback` despliega una imagen de API rota a propósito, verifica que el gate la rechaza y vuelve al tag bueno.

## 5. Pérdida de Redis

Síntoma: `/readyz` con `redis=down`; runs nuevos quedan `QUEUED`; aprobaciones quedan registradas pero el run no avanza.

1. No hace falta intervenir datos: la API sigue aceptando runs y decisiones (el dispatch a la cola es best-effort con timeout de 1,5 s; el run ya es durable en PostgreSQL).
2. Al volver Redis el worker re-registra sus schedulers (log `redis reconnected`) y dispara el sweep de recuperación, que reconstruye desde PostgreSQL los runs `QUEUED`, los `RUNNING` con lease vencido y los `WAITING_HUMAN` con decisión. Los leases y la ejecución idempotente impiden doble efecto.
3. Los rate limits de escritura (tickets por sujeto/hora) están en PostgreSQL y siguen aplicando durante el corte.

Ensayo: `pnpm prod:drill redis`.

## 6. Backup y restore

Backup lógico: `docker compose -f infra/compose.prod.yaml exec -T postgres pg_dump -U commerce_admin -Fc commerce > backup.dump`. Para un snapshot comparable se pausa el worker (único escritor en segundo plano). El ensayo `pnpm prod:drill restore` lo automatiza: dump, restore en un PostgreSQL aislado (`infra/restore-compose.yaml`, red interna, sin puerto publicado), creación previa de los roles de la app como `NOLOGIN`, y verificación de conteos por tabla, estado de runs, último evento de auditoría, FKs validadas sin huérfanos, políticas RLS y migraciones aplicadas. El dump queda en `.local/prod/backups/` con su `*.verify.json`. En Azure el equivalente es el point-in-time restore de Flexible Server (backups de 7 días) a un servidor aislado (no ensayado).

## 7. Retención

`pnpm db:retention` (o `node dist/cli.js retention` en la imagen `migrate`) ejecuta `commerce.apply_retention(now())`: borra estado de runs > 30 días y el texto libre del usuario, consentimientos e idempotencia > 30 días; requests/aprobaciones/ejecuciones/auditoría decididas > 90 días. Programarlo diario (cron del host o un CronJob de Kubernetes con la imagen `migrate`); no está programado en el stack local.

## 8. Calidad y carga

- `pnpm verify`: lint, formato, typecheck, build, tests, contratos y evals de desarrollo.
- `pnpm evals:release`: holdout ×3, gates de `evals/gates/gates.v0.json`; sale con 1 si un gate falla.
- `pnpm load`: 5 min de warm-up + 15 min con 10 sesiones contra los builds locales (latencia de lectura y alertas MEASURED; latencia/tokens del workflow con proveedor SIMULATED).

## 9. Tiempos observados

Última ejecución (2026-10-01, una observación cada uno; detalle en `openspec/changes/archive/2026-10-01-add-cloud-deployment-demo/verification.md`). No son SLA.

| Operación | Observado |
|---|---|
| Build de las 5 imágenes (en frío) / `prod:up` con imágenes listas | 238 s / 12 s |
| Run de demo de extremo a extremo (3 casos; aprobación completa) | 0,44–0,49 s; 1,25 s |
| Aceptar un run con Redis caído | 1,5 s (timeout de dispatch) |
| Recuperación de trabajo tras volver Redis | 5,4 s |
| Restart api + worker hasta ready | 3,4 s |
| Rollback: detectar release rota / volver al tag anterior | 2,9 s / 4,8 s |
| Backup (pg_dump, 214 KiB) / restore aislado completo | 0,40 s / 4,8 s |
| k3s local: cluster listo / import de imágenes / despliegue hasta ready | 10,7 s / 154 s / 54 s |

## AKS (listo para desplegar, pendiente de autorización)

Decisión del dueño del repo (2026-10-01): el destino es Azure Kubernetes Service, con alcance "listo para desplegar". Nada se aplicó en Azure; aplicar es un paso futuro que requiere autorización explícita.

### Artefactos

| Ruta | Contenido |
|---|---|
| `infra/terraform/azure` | `azurerm` 4.x: resource group, VNet con subred AKS, subred delegada para PostgreSQL y subred de private endpoints; AKS (Azure CNI overlay + Cilium, OIDC issuer, workload identity, driver Key Vault CSI, add-on app-routing, Entra ID + Azure RBAC, cuentas locales deshabilitadas); ACR (AcrPull al kubelet); PostgreSQL Flexible Server sin acceso público con `azure.extensions=VECTOR,PGCRYPTO`; Azure Cache for Redis sólo TLS con private endpoint; Key Vault RBAC con los secretos generados; identidad de la app federada con `system:serviceaccount:commerce:commerce-app`; identidad de despliegue federada con GitHub (`repo:<owner>/<repo>:environment:aks-demo`, AcrPush + RBAC Writer sólo en el namespace); budget al 80 % previsto. `terraform.tfvars.example` con placeholders. |
| `infra/k8s/base` | Namespace (PSA baseline, warn restricted), ServiceAccount, ConfigMap, Job `migrate` (`migrate` + `seed --if-empty`), Deployments api/worker/mcp/web con startup/liveness/readiness, requests/limits, raíz de sólo lectura, HPA (api/web 2–4, worker 1–3), PDB, Services, Ingress (`/v1` y `/healthz` a la API, el resto a la consola) y NetworkPolicies (deny por defecto, sólo el ingress entra, sólo pods `data-access` salen a los datos). |
| `infra/k8s/overlays/aks` | `params.env` (placeholders), tres `SecretProviderClass` (app, web, migrate) con workload identity, volúmenes CSI, clase `webapprouting.kubernetes.azure.com` con certificado de Key Vault, egress a las subredes de datos, imágenes de ACR. |
| `infra/k8s/overlays/local` | PostgreSQL (pgvector) y Redis en el cluster, sólo accesibles por pods `data-access`; Traefik de k3s. Lo usa `pnpm k8s:local`. |
| `.github/workflows/deploy.yml` | `workflow_dispatch` con un SHA de 40 caracteres; login OIDC sin secretos; build/push a ACR con tags SHA inmutables (no reescribe un tag existente); overlay de release; Job de migración y espera; rollout con `rollout undo` si falla; smoke por el ingress. Inerte sin `DEPLOY_ENABLED=true`. Nunca se ejecutó. |

### Prerrequisitos que provee el dueño

1. Suscripción de Azure y región con AKS, PostgreSQL Flexible Server 17 (pgvector) y Azure Cache for Redis.
2. Presupuesto mensual y destinatarios de alertas.
3. Dominio y certificado TLS: un certificado en Key Vault (`TLS_CERT_KEYVAULT_URI`) y el registro DNS del host público hacia la IP del ingress de app-routing.
4. GitHub: environment `aks-demo` con la credencial federada que crea Terraform, y variables `DEPLOY_ENABLED`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_AKS_NAME`, `AZURE_ACR_NAME`, `AZURE_KEY_VAULT_NAME`, `AZURE_WORKLOAD_CLIENT_ID`, `PUBLIC_HOST`, `TLS_CERT_KEYVAULT_URI`, `DATA_SUBNETS_CIDR`. GitHub Actions hoy está bloqueado por billing.
5. Un emisor de identidad real para producción: el sign-in de demo de la consola no es un IdP.

### Costo orientativo

Hoy: 0 (nada aplicado). Con los valores por defecto la topología tiene costo mensual: 2 nodos `Standard_B2s`, PostgreSQL `B_Standard_B1ms` con 32 GiB, Redis Basic C0, ACR Basic, load balancer e IP pública del ingress, Key Vault y tráfico. Orden de magnitud estimado **USD 120–180/mes**, sin verificar contra la calculadora de precios de una región concreta; el control plane de AKS en tier Free no se cobra. El budget avisa al 80 % previsto. No es de costo cero.

### Comandos para un despliegue futuro (sólo con autorización)

```bash
# 1. Infraestructura (state remoto protegido: contiene las URLs de la BD)
cd infra/terraform/azure
cp terraform.tfvars.example terraform.tfvars        # completar placeholders
az login && terraform init -backend-config=backend.hcl
terraform plan -out tfplan                          # revisar costo y recursos
terraform apply tfplan

# 2. Claves del emisor y certificado (la clave privada no entra al state)
pnpm prod:secrets
KV=$(terraform output -raw key_vault_name)
az keyvault secret set --vault-name "$KV" --name jwks --file ../../../.local/prod/jwks.json
az keyvault secret set --vault-name "$KV" --name issuer-private-jwk --file ../../../.local/prod/issuer-private.jwk.json
az keyvault certificate import --vault-name "$KV" --name edge-tls --file <cert.pfx>

# 3. Variables del environment aks-demo en GitHub desde `terraform output`; luego:
gh workflow run deploy.yml -f ref=<commit-sha-completo>
```

Sin GitHub Actions, los pasos del workflow se pueden ejecutar a mano con `az`, `docker` y `kubectl` en el mismo orden: build/push, `kubectl kustomize` del overlay, `kubectl apply -l app.kubernetes.io/component=platform`, Job `migrate` y `kubectl wait`, `component=app` y `rollout status`.

### Validación local hecha (sin costo)

- `terraform fmt -check`, `terraform init -backend=false` y `terraform validate` con la imagen oficial `hashicorp/terraform:1.9.8` (azurerm 4.81.0): válido, 0 warnings.
- `kubectl kustomize` de ambos overlays y `kubeconform -strict` (Kubernetes 1.33, esquemas de CRDs para `SecretProviderClass`): todos los recursos válidos.
- `pnpm k8s:local`: overlay local en k3s dentro de Docker, demo completa por el ingress TLS, rollout roto contenido y revertido, Job de migración re-ejecutado sin perder datos. El cluster se borra al terminar.

No se validó contra Azure real: driver CSI con Key Vault, app-routing, workload identity, Flexible Server (admin no superusuario) y private endpoints sólo se probarán al aplicar.
