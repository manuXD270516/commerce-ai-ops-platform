# Verification

## Estado

Completado con el alcance re-definido por el dueño del repo (2026-10-01): **AKS listo para desplegar, no desplegado**. Todo se ejecutó en local y sin costo; ningún recurso cloud se creó, no hubo `terraform apply`, login en Azure ni servicios pagos. Aplicar en Azure es un paso futuro que requiere autorización explícita.

## Evidencia exigida

Gate de salida (roadmap): smoke con 3 casos, rollback y restart; restauración ensayada; costo/latencia etiquetados; configuración AKS validada localmente.

## Resultados

Reportes en [`evidence/`](evidence/), de las corridas finales sobre las imágenes del commit `17a1086`. Una estación (Windows 11, Docker Desktop); tiempos de una observación, **no SLA**. Síntesis por plantilla (SIMULATED), sin LLM.

### Escenario "Deployment-ready validation without cloud resources"

| Validación | Resultado | Evidencia |
|---|---|---|
| `terraform fmt -check`, `init -backend=false`, `validate` (imagen oficial `hashicorp/terraform:1.9.8`, azurerm 4.81.0, random 3.9.1) | válido, 0 warnings | [`iac-validation.txt`](evidence/iac-validation.txt) |
| `kubectl kustomize` de `overlays/local` y `overlays/aks` + `kubeconform -strict` (Kubernetes 1.33, catálogo de CRDs para `SecretProviderClass`) | 53/53 recursos válidos | [`iac-validation.txt`](evidence/iac-validation.txt), [`aks-rendered.yaml`](evidence/aks-rendered.yaml) (sólo placeholders) |
| `pnpm k8s:local`: overlay local en k3s v1.33.1 dentro de un contenedor Docker (`commerce-ai-ops-k3s`, borrado al terminar) | 11/11 | [`m11-k8s-local-…-ecf5.md`](evidence/m11-k8s-local-20261001T233643-ecf5.md), [`k8s-local-console.txt`](evidence/k8s-local-console.txt) |
| — Job `migrate` (migrate + `seed --if-empty`), apps con probes, ingress TLS con CA desechable | pass; cluster listo 10,7 s, despliegue hasta ready 54 s, import de imágenes 154 s | |
| — NetworkPolicy: web no alcanza PostgreSQL, api sí | web `ECONNREFUSED`, api `open` | |
| — Demo completa por el ingress (3 casos, aprobación, replay) | 18/18 | [`m11-demo-k8s-…-aaaa.md`](evidence/m11-demo-k8s-20261001T234026-aaaa.md) |
| — Release roto de la API: nunca ready, pods anteriores siguen sirviendo; `rollout undo` restaura | pass | |
| — Re-ejecutar el Job de migración conserva datos (`seeded:false`, agent_runs 4 → 4) | pass | |

Hallazgos durante la validación, corregidos: los recursos del overlay se creaban fuera del namespace (faltaba `namespace` en los overlays); en k3s los pods nuevos de un Job pueden recibir el permiso de red con retraso, por eso el Job reintenta con back-off (`backoffLimit: 6`); el script consultaba el ingress sin confiar en la CA local. Al mover las cabeceras de seguridad a las apps, el E2E mostró que `Referrer-Policy: no-referrer` hace que el navegador envíe `Origin: null` en el POST del login y el chequeo same-origin lo rechaza; el Caddyfile tenía el mismo defecto latente (la demo usa fetch con Origin explícito y no lo detectaba). Ahora es `same-origin` en Caddy, API y consola; E2E 8/8.

### Escenario "Secrets never inline"

Ningún secreto en `infra/k8s`, `infra/terraform/azure` ni `deploy.yml`: el render de AKS no contiene `Secret` ni valores sensibles; los volúmenes usan el driver CSI con tres `SecretProviderClass` y workload identity; el workflow usa OIDC federado. En k3s el `Secret` lo crea el script desde `.local/prod` (git-ignored). Terraform escribe URLs y clave PII en Key Vault (también quedan en el state: backend protegido); la clave privada del emisor se carga fuera de banda.

### Stack production-like (Compose)

Demo (`pnpm prod:demo`) 18/18 sobre `https://localhost:8443` — [`m11-demo-…-3b88.md`](evidence/m11-demo-20261001T233530-3b88.md). Ensayos (`pnpm prod:drill`) 21/21 — [`m11-recovery-drill-…-f473.md`](evidence/m11-recovery-drill-20261001T233549-f473.md).

| Ensayo | Verificado | Tiempos observados |
|---|---|---|
| Redis (escenario "Redis restart") | readyz 503; API acepta run (202) y decisión durante el corte; rate limit de tickets aplicado desde PostgreSQL; al volver, run y acción aprobada completan; 1 aprobación, 1 ejecución, 1 evento `completed` por run; schedulers re-registrados | aceptar run 1,5 s; recuperación 5,4 s tras volver Redis |
| Restart api + worker | ready vía edge; run nuevo completa | 3,4 s |
| Rollback | imagen rota rechazada por el gate de health; tag inmutable anterior sirve; datos intactos | detección 2,9 s; restauración 4,8 s |
| Backup/restore aislado (escenario "Restore rehearsal") | conteos por tabla, estado de runs, último evento de auditoría, 72 FKs sin huérfanos, 45 políticas en 36 tablas con RLS, 9 migraciones | dump 0,40 s (214 KiB); restore total 4,8 s |
| Persistencia | ningún ensayo resetea datos (agent_runs 11 → 14; corrección `seed --if-empty`) | — |

### Costo

Costo incurrido: 0. Estimación orientativa de la topología AKS por defecto en el runbook (orden de USD 120–180/mes, sin verificar por región); no es de costo cero.

## Pendiente (fuera del alcance acordado)

- Aplicar en Azure: requiere autorización, suscripción, región, presupuesto, DNS/TLS y credencial federada de GitHub. Lo no verificable sin Azure (driver CSI con Key Vault, app-routing, workload identity, admin no superusuario de Flexible Server, private endpoints) se probará al aplicar.
- `deploy.yml` y el job `prod-like` de CI nunca se ejecutaron (GitHub Actions bloqueado por billing).
- Point-in-time restore gestionado no ensayado; sólo pg_dump/pg_restore local.
