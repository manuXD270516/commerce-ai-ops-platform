## Why

Antes de construir dominio, retrieval, MCP y agentes, el proyecto necesita un diseño revisado y una base técnica reproducible: monorepo con versiones exactas, entorno local, CI, correlación y trazas, y un harness de evals que no confunda objetivos con mediciones.

## What Changes

- Registrar la revisión de diseño previa a M0 y las decisiones de bootstrap (ver design.md §6).
- Crear el monorepo TypeScript con `apps/web`, `apps/api`, `apps/worker`, `apps/commerce-mcp-server` y los paquetes previstos, como esqueletos que compilan y arrancan.
- Configurar Compose con PostgreSQL + pgvector y Redis, `.env.example` sin secretos, CI y un smoke reproducible con correlation id.
- Crear el harness de fixtures y evals con reportes EXPECTED/SIMULATED/MEASURED y tracing inicial con OpenTelemetry.

Este change nació como contrato completo del MVP (M0–M11). Tras completar M0 se dividió: los requisitos y tareas de M1–M11 se trasladaron sin cambios a un change por milestone (`add-commerce-domain-model`, `add-catalog-api`, `add-orders-and-inventory`, `add-hybrid-retrieval`, `add-controlled-mcp`, `add-agent-router`, `add-specialist-agents`, `add-human-approval`, `add-operations-console`, `add-evaluation-gates`, `add-cloud-deployment-demo`). El alcance del MVP vive en `docs/mvp-scope.md` y la arquitectura en `docs/architecture.md`.

## Capabilities

### New Capabilities

- `evaluation-observability`: bootstrap reproducible con smoke correlacionado y ciclo de vida spec-driven por milestone. El resto de la capability llega en M10 y M11.

### Modified Capabilities

Ninguna; proyecto nuevo.

## Impact

Sin lógica de dominio, migraciones de negocio, llamadas a modelos, embeddings ni recursos cloud. La página web es un scaffold técnico, no la consola de M9. Transportistas y notificaciones siguen fuera de alcance hasta su milestone.

## Non-goals

Todo lo que corresponde a M1–M11; las exclusiones funcionales del MVP están en `docs/mvp-scope.md`.

## Success Criteria

Desde un clone limpio pasan install, lint, formato, typecheck, build, tests, contratos, evals y OpenSpec estricto; el smoke demuestra que las cuatro apps arrancan y que un request web → api comparte correlation id y trace id en logs estructurados.
