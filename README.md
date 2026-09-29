# commerce-ai-ops-platform

Plataforma de operaciones e-commerce con APIs de dominio, búsqueda híbrida, workflows asistidos por IA y acciones auditables mediante MCP.

**Estado: M0 (bootstrap), M1 (modelo de dominio) M2 (API de catálogo con identidad verificada) y M3 (órdenes, inventario y detector de anomalías) completados; M4–M11 en curso.** Existe el monorepo con web, API, worker y servidor MCP, entorno local, CI, harness de evals y tracing, y un modelo relacional multi-tenant con RLS, snapshots, outbox, auditoría e idempotencia (`pnpm db:migrate`, `pnpm db:seed`). Hay código preliminar de milestones posteriores que aún no está verificado contra sus changes. No hay llamadas a modelos de terceros ni recursos cloud. La página web es un scaffold técnico, no la consola de M9. Datos de demostración sintéticos, USD, una región logística y dos tenants de prueba para verificar aislamiento. Transportistas y notificaciones serán simulados y visibles como tales. PostgreSQL contendrá datos relacionales operativos; las respuestas no dependerán de hechos inventados por el modelo.

## Documentación

- [Alcance del MVP](docs/mvp-scope.md)
- [Arquitectura, bounded contexts y decisiones](docs/architecture.md) (revisión previa a M0 en §6)
- [Modelo de datos](docs/data-model.md)
- [Agentes, permisos MCP y seguridad](docs/agents-security-mcp.md)
- [RAG y evaluaciones](docs/rag-evals.md)
- [Roadmap M0–M11](docs/roadmap.md), con el change de OpenSpec de cada milestone
- Changes activos en [openspec/changes](openspec/changes) (uno por milestone, con tasks.md y verification.md); M0 archivado en `openspec/changes/archive/`, specs promovidas en [openspec/specs](openspec/specs)

## Estructura

```text
apps/web                  Next.js 16: página de estado y /api/status (diagnóstico web → API)
apps/api                  NestJS 12: /healthz, /readyz, /v1/status
apps/worker               BullMQ: cola de diagnóstico sin payload de negocio
apps/commerce-mcp-server  Sólo probes; el endpoint MCP autenticado llega en M5
packages/contracts        JSON Schema 2020-12, OpenAPI 3.1, tipos generados, correlation id
packages/domain           Servicios de aplicación desde M1 (sin frameworks ni IA)
packages/ai               Adaptadores de proveedor desde M6 (hoy sólo ProviderMode)
packages/telemetry        Logs JSON, correlación, OpenTelemetry y probes
evals                     Fixtures versionadas, gates EXPECTED y reportes
infra                     Compose local y smoke
```

## Desarrollo local

Requisitos: Node 22.23.1 (`.nvmrc`), pnpm 12.4.2 y Docker con Compose. Desde un clone limpio:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env          # Linux/macOS: cp .env.example .env
pnpm run auth:init                   # claves del issuer local en .local/auth (git-ignored)
pnpm run infra:up:tracing            # PostgreSQL + pgvector, Redis y Jaeger en 127.0.0.1
pnpm run verify                      # lint, formato, typecheck, build, tests (contra la BD), contratos, evals
pnpm run db:migrate                  # schema y roles; db:seed carga los fixtures sintéticos
pnpm run db:seed
pnpm run openspec:validate
pnpm run smoke -- --tracing          # arranca las cuatro apps y verifica la correlación
pnpm run infra:down
```

`pnpm run infra:up` levanta sólo PostgreSQL y Redis; en ese caso ejecutar `pnpm run smoke` sin `--tracing`. Para arrancar las apps a mano tras `pnpm run build`: `pnpm start:api`, `pnpm start:worker`, `pnpm start:mcp` y `pnpm start:web` (http://127.0.0.1:3000). Los reportes se escriben en `evals/reports/` y `.smoke/`, ambos ignorados por git.

La API y el servidor MCP sólo aceptan `Authorization: Bearer <JWT ES256>` firmado por el issuer configurado (`AUTH_ISSUER`, `AUTH_JWKS_FILE`), con audiencias separadas `commerce-api` y `commerce-mcp`. El tenant sale del token y el rol de la membership en la BD. En local, la consola web firma tokens de corta vida para los usuarios de demostración; en cloud se sustituye por un proveedor OIDC.

## Flujo de trabajo

Cada feature sigue proposal → spec → design → tasks → implementation → verification, con un change por milestone. Cualquier variación funcional requiere actualizar estos artefactos antes de implementar; nuevas capacidades requieren su propio change. Los delta specs permanecen en el change hasta verificar y archivar.

Los umbrales de evaluación son objetivos propuestos (EXPECTED), no resultados medidos.
