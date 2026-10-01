## Context

Milestone M11. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §5. Operación en [runbook.md](../../../docs/runbook.md).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M11 (smoke con 3 casos, rollback y restart; restauración ensayada; costo/latencia etiquetados) y dejar el despliegue en AKS listo para aplicar. No objetivos: aplicar la IaC o desplegar en Azure (requiere autorización explícita del dueño), datos reales de clientes y SLA no medidos.

## Decisions

1. **Destino AKS, alcance "listo para desplegar" (decisión del dueño del repo, 2026-10-01).** Reemplaza el plan anterior en AWS (ECS), retirado del repositorio. Todo lo necesario para un despliegue futuro existe y se valida localmente sin costo; aplicar en Azure es un paso futuro con autorización explícita, suscripción, región, presupuesto, DNS/TLS y credencial federada de GitHub.
2. **Dos niveles ejecutables localmente.** Stack *production-like* con Compose (`infra/compose.prod.yaml`) para demo y ensayos de recuperación, y los manifiestos Kubernetes desplegados en un k3s local (`pnpm k8s:local`) para probar los mismos artefactos que irían a AKS.
3. **Imágenes inmutables.** Un `infra/docker/Dockerfile` multi-target (api, worker, mcp, web, migrate) desde `node:22.23.1-bookworm` y el lockfile congelado; tag = commit SHA completo; usuario `node` (uid 1000), raíz de solo lectura en Kubernetes. Imágenes de terceros pinneadas por versión y digest.
4. **Secretos fuera de manifiestos.** Las apps leen archivos (`*_FILE`). Compose: secrets montados desde `.local/prod` (`pnpm prod:secrets`). AKS: Key Vault → driver Secrets Store CSI con workload identity, una `SecretProviderClass` por consumidor (app, web, migrate) para que cada pod reciba sólo lo suyo. k3s local: un `Secret` creado por el script desde `.local/prod`, nunca en el repo. Terraform genera las URLs y la clave PII en Key Vault (quedan en el state: backend protegido); las claves JWK del emisor se cargan fuera de banda para que la privada no entre al state.
5. **Borde TLS y redes privadas.** Caddy (Compose), Traefik (k3s) o el add-on app-routing de AKS (NGINX gestionado, certificado desde Key Vault) enrutan sólo `/v1/*` y `/healthz` a la API y el resto a la consola; MCP y worker no se enrutan. Las apps ponen nosniff/frame deny/referrer policy y HSTS detrás de TLS, sea cual sea el borde. NetworkPolicies: deny por defecto; sólo el controlador de ingress entra a api/web; sólo pods `commerce.io/data-access=true` (api, worker, mcp, migrate; nunca web) alcanzan PostgreSQL/Redis (pods locales o subredes privadas en Azure). PostgreSQL Flexible Server con subred delegada y Redis con private endpoint, sin acceso público.
6. **Migraciones y seed.** Job `migrate` forward-only antes de las apps (Compose: `service_completed_successfully`; Kubernetes: se aplica el Job, se espera `complete` y luego se despliegan las apps); el seed sólo corre con la base vacía (`seed --if-empty`). Hallazgo del primer ensayo: el job se re-ejecutaba y su seed borraba datos; corregido y verificado en Compose y en k3s. `migrate.ts` sólo toca `BYPASSRLS` si hace falta, porque el admin de Flexible Server no es superusuario.
7. **Recuperación desde PostgreSQL.** Redis sin persistencia; dispatch best-effort (1,5 s); el worker re-registra schedulers y dispara el sweep al reconectar. Rate limits de escritura en PostgreSQL.
8. **Rollback.** Compose: redeploy del tag anterior con gate de health. Kubernetes: `maxUnavailable: 0` mantiene los pods viejos mientras un release roto no pasa readiness; `kubectl rollout undo` restaura. El workflow deshace automáticamente si un rollout falla.
9. **Escalado.** Requests/limits en todos los pods; HPA por CPU para api y web (2–4) y worker (1–3; leases hacen seguro escalar); PDB para api y web.
10. **Despliegue desde GitHub.** `deploy.yml` sólo `workflow_dispatch`, inerte sin `DEPLOY_ENABLED`; login OIDC con identidad administrada federada (sin secretos), build/push a ACR con tags SHA inmutables, overlay de release con los valores del proveedor, job de migración y rollout con undo. No se ejecutó.
11. **Costo.** No se aplica nada, costo actual 0. La topología propuesta tiene costo mensual (nodos AKS, Flexible Server, Redis, Key Vault, IP pública del ingress); estimación orientativa en el runbook, sin precios verificados para una región concreta.

## Open Questions

Suscripción, región, presupuesto, dominio/certificado y credencial federada de GitHub (las provee el dueño); evaluar Node 24 LTS y PostgreSQL 18 frente al servicio gestionado.
