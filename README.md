# commerce-ai-ops-platform

Plataforma de operaciones e-commerce con APIs de dominio, búsqueda híbrida, workflows asistidos por IA y acciones auditables mediante MCP.

**Evidencia publicada:** https://manuxd270516.github.io/commerce-ai-ops-platform/ (página estática con arquitectura, gates de evaluación, demo, ensayos de recuperación y preparación para AKS; sin backend, datos sintéticos).

## Estado (2026-10-02)

- **Completados y archivados (M0–M9):** bootstrap, modelo de dominio multi-tenant con RLS, API de catálogo, órdenes/inventario/anomalías, recuperación híbrida versionada, servidor MCP con ocho tools, router y ejecución durable con LangGraph, especialistas con evidencia, aprobación humana con consumo atómico y consola operacional con E2E por rol.
- **M10 evaluaciones — completado con excepciones aceptadas.** 300 casos (`ops-eval@1.0.0`) ejecutados de extremo a extremo, tres repeticiones, gates de release, carga de 20 min, auditoría de PII, trazas y retención. La release sobre el holdout **falla 2 de 21 gates de calidad**: routing macro-F1 0,936 (gate 0,95) y MRR@5 0,792 (gate 0,8). El dueño del repo aceptó el resultado como limitación conocida (2026-10-01), sin cambiar valores ni umbrales; siguiente paso: nuevo ciclo de ajuste con holdout nuevo. Ningún gate de seguridad falla (0 efectos y 0 lecturas indebidas). **Punto abierto:** las etiquetas no tienen adjudicación de dos revisores; protocolo, herramientas y hojas ciegas listos en el change [`adjudicate-eval-labels`](openspec/changes/adjudicate-eval-labels), a la espera de un segundo revisor humano. Detalle: [verification](openspec/changes/archive/2026-10-01-add-evaluation-gates/verification.md).
- **M11 despliegue — completado como "listo para AKS"; no desplegado.** Stack production-like local (imágenes inmutables, TLS en el borde, secretos como archivos, red de datos privada) con demo de 3 casos + aprobación + replay (18/18) y ensayos de Redis, restart, rollback y backup/restore aislado (21/21). Destino cloud: **Azure Kubernetes Service** (decisión del dueño, 2026-10-01) con Terraform `azurerm`, manifiestos Kustomize (Key Vault CSI + workload identity, app-routing con TLS, NetworkPolicies, HPA, Job de migración que no resetea datos) y workflow de deploy manual con OIDC. Validado sólo localmente y sin costo: `terraform validate`, kubeconform y despliegue en k3s dentro de Docker con la misma demo. **Listo, requiere una suscripción paga de Azure**: no se aplicó nada en Azure; hace falta autorización, suscripción, región, presupuesto, DNS/TLS y credencial federada ([runbook](docs/runbook.md#aks-listo-para-desplegar-pendiente-de-autorización)). Detalle: [verification](openspec/changes/archive/2026-10-01-add-cloud-deployment-demo/verification.md).
- **CI:** GitHub Actions con los jobs `checks` (incluye gitleaks sobre el historial, `pnpm audit` de severidad alta y el build del sitio), `smoke` (incluye E2E) y `prod-like` (stack production-like, demo, ensayos de recuperación y manifiestos en k3s); `pages` publica el sitio sólo después de un `ci` verde. Corridas verdes recientes: [36976977292](https://github.com/manuXD270516/commerce-ai-ops-platform/actions/runs/36976977292) (dos intentos). `deploy.yml` (AKS) nunca se ejecutó.

Sin llamadas a modelos ni embeddings de terceros: embeddings por hashing local determinístico (`local-hash-v1`) y redacción por plantilla (`template-synth.v1`), etiquetada SIMULATED en reportes y UI; los proveedores reales quedan como opción apagada. Por eso latencia de workflow, tokens y costo son SIMULATED y no certifican un modelo real. Datos sintéticos, USD, dos tenants; transportistas y notificaciones simulados y visibles como tales.

## Documentación

- [Alcance del MVP](docs/mvp-scope.md)
- [Arquitectura, bounded contexts y decisiones](docs/architecture.md)
- [Modelo de datos](docs/data-model.md)
- [Agentes, permisos MCP y seguridad](docs/agents-security-mcp.md)
- [RAG y evaluaciones](docs/rag-evals.md)
- [Runbook](docs/runbook.md): stack production-like, rollback, Redis, backup/restore, retención, plan cloud
- [Roadmap M0–M11](docs/roadmap.md), con el change de OpenSpec de cada milestone
- Changes archivados en `openspec/changes/archive/` (M0–M11 y el sitio de evidencia), specs promovidas en [openspec/specs](openspec/specs); abierto: `adjudicate-eval-labels` (requiere un segundo revisor humano)

## Estructura

```text
apps/web                  Next.js 16: consola operacional (BFF, sesión firmada, SSE, aprobaciones)
apps/api                  NestJS 12: catálogo, órdenes, runs de agentes, aprobaciones, tickets
apps/worker               BullMQ: runs de agentes, recuperación desde PostgreSQL, detector de anomalías
apps/commerce-mcp-server  MCP Streamable HTTP autenticado (SDK 1.31.0, protocolo 2025-11-25), ocho tools
packages/contracts        JSON Schema 2020-12, OpenAPI 3.1, tipos, tokens
packages/tools            Enforcement único de tools: schema, scopes, consentimiento, auditoría
packages/domain           Servicios de dominio, migraciones, RLS, retención
packages/ai               Router, grafo LangGraph, especialistas, embeddings locales
packages/telemetry        Logs JSON, correlación, OpenTelemetry y probes
evals                     Datasets versionados, suites, gates de release, PII, dashboard
infra                     Compose local y production-like, Dockerfile, smoke, carga, demo, drills,
                          Terraform Azure (infra/terraform/azure) y manifiestos Kubernetes (infra/k8s)
```

## Desarrollo local

Requisitos: Node 22.23.1 (`.nvmrc`), pnpm 12.4.2 y Docker con Compose.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env          # Linux/macOS: cp .env.example .env
pnpm run auth:init                   # claves del issuer local en .local/auth (git-ignored)
pnpm run infra:up:tracing            # PostgreSQL + pgvector, Redis y Jaeger en 127.0.0.1
pnpm run db:migrate; pnpm run db:seed
pnpm run verify                      # lint, formato, typecheck, build, tests, contratos, evals de dev
pnpm run smoke -- --tracing          # arranca las cuatro apps y verifica correlación, MCP y un run
pnpm run e2e                         # Playwright por rol
pnpm run evals:release               # holdouts ×3 y gates (sale con 1 si alguno falla)
pnpm run load                        # 20 min de carga local
pnpm run infra:down
```

Stack production-like (ver [runbook](docs/runbook.md)): `pnpm prod:secrets`, `pnpm prod:up`, `pnpm prod:demo`, `pnpm prod:drill`, `pnpm prod:down`. Manifiestos de Kubernetes en un k3s desechable dentro de Docker: `pnpm k8s:local` (usa las imágenes de `prod:up` y borra el cluster al terminar). Los reportes se escriben en `evals/reports/` y `.smoke/` (ignorados por git); los de la última verificación están copiados en `openspec/changes/*/evidence/`.

La API y el servidor MCP sólo aceptan `Authorization: Bearer <JWT ES256>` del issuer configurado, con audiencias separadas `commerce-api` y `commerce-mcp`. El tenant sale del token y el rol de la membership en la BD. La consola firma tokens de corta vida para usuarios de demostración; no es un IdP de producción.

## Flujo de trabajo

Cada feature sigue proposal → spec → design → tasks → implementation → verification, con un change por milestone; un change se archiva sólo cuando todas sus tareas tienen evidencia. Los umbrales de `evals/gates/gates.v0.json` son objetivos de demo; los valores observados y su estado (MEASURED/SIMULATED) están en los reportes de release.
