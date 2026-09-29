# Verification

## Estado de esta entrega

Fase: M0 completado (tareas 1.1–1.3). No hay lógica de dominio, migraciones, llamadas a modelos ni recursos cloud; ningún gate funcional de docs/rag-evals.md se considera aprobado, todos siguen EXPECTED.

Validación documental ejecutada el 2026-09-23: `openspec validate define-commerce-ops-mvp --strict` terminó con exit code 0 y resultado `Change 'define-commerce-ops-mvp' is valid`. La validación de formato no demuestra comportamiento del sistema.

## Resultados M0 (2026-09-29)

Commit verificado: `a2f0617` (implementación en `05b3869` y `a2f0617`). Entornos: Windows 11 x64 con Node 22.23.1, pnpm 12.4.2, Docker 29.8 y Compose v5.5.1; y contenedor `node:22.23.1-bookworm` (Linux x86_64) conectado a la red de Compose.

| Verificación | Windows, clone limpio en `D:\tmp\m0c` | Linux (contenedor) |
|---|---|---|
| `pnpm install --frozen-lockfile` (incluye política `minimumReleaseAge` de 24 h) | exit 0 | exit 0 |
| `pnpm run lint` (ESLint type-checked + boundaries) | exit 0 | exit 0 |
| `pnpm run format:check` | exit 0 | exit 0 |
| `pnpm run typecheck` (9 proyectos, sin build previo) | exit 0 | exit 0 |
| `pnpm run build` (4 paquetes, 4 apps, evals) | exit 0 | exit 0 |
| `pnpm run test` (Vitest, 9 proyectos, 37 tests) | exit 0 | exit 0 |
| `pnpm run contracts:check` (tipos sin drift + Redocly lint de OpenAPI 3.1) | exit 0 | exit 0 |
| `pnpm run evals` (3 reportes válidos) | exit 0 | exit 0 |
| `pnpm run openspec:validate` (OpenSpec 1.11.0, `--all --strict`) | exit 0 | exit 0 |
| Smoke (`infra/scripts/smoke.mjs`) | 13/13 con `--tracing` | 12/12 sin tracing |

Smoke, evidencia principal de 1.2: las cuatro apps arrancan desde sus builds; la readiness de la API ve PostgreSQL, la extensión `vector` disponible y Redis; 20 de 20 requests `web /api/status → api /v1/status` devuelven el `X-Correlation-Id` enviado y aparecen con el mismo `correlation_id` y el mismo `trace_id` en los logs JSON de web y API; un correlation id malformado se reemplaza y no llega a ningún log; el worker registra el `correlation_id` de un job tras pasar por Redis; `POST /mcp` responde 404; con `--tracing`, Jaeger contiene una traza con spans de `web` y `api`. Latencia web → api medida en el smoke (MEASURED, n=20, host local, endpoint de diagnóstico): p50 31 ms, p95 33 ms; no corresponde al gate `api_read_latency_p95`.

Pruebas adicionales: con la API corriendo y Redis detenido, `/readyz` devolvió 503 con `redis=down` y volvió a 200 al reiniciar Redis. Una importación `@commerce/ai` desde `packages/domain` fue rechazada por `no-restricted-imports`. `gitleaks git` 8.30.1 sobre el historial: 4 commits, sin hallazgos (en modo directorio sólo marca claves de preview que Next.js genera en `.next/`, ignorado por git). `actionlint` 1.7.12 sobre `.github/workflows/ci.yml`: sin errores.

Reportes de evals (1.3): `demo-gates` con 21 resultados EXPECTED tomados de docs/rag-evals.md (sin valores); `correlation-contract` MEASURED contra `normalizeCorrelationId`, 8/8 casos; `simulated-selftest` SIMULATED, 3/4 con un desacuerdo deliberado. Los tests rechazan un run simulado que declare resultados MEASURED, un EXPECTED con valor observado, observaciones sin denominador y fixtures cuyo checksum no coincide con su manifest.

Limitaciones: el workflow de GitHub Actions no se ha ejecutado en GitHub porque el repositorio no tiene remoto; sus comandos se reprodujeron en Linux usando corepack en lugar de `pnpm/action-setup`. Las cifras de latencia provienen de un host de desarrollo y sólo describen la infraestructura del smoke.

## Revisión de diseño previa a M0

Realizada el 2026-09-29, requisito "Diseño revisado" de M0 en docs/roadmap.md. Alcance: coherencia entre design.md, docs/ y specs, y decisiones que bloqueaban el bootstrap (gestor y workspaces, runtime, versiones de Next.js/NestJS/LangGraph JS, persistencia y migraciones, formato de contratos, estrategia de tests, observabilidad, entorno local y CI). Resultado: 16 decisiones registradas en design.md §6, ninguna altera comportamiento ni alcance funcional. Pendiente derivado: reformular el escenario "Documentation-only delivery" antes de archivar.

## Matriz de trazabilidad prevista

| Capability | Milestones/tareas | Evidencia que exigirá implementación |
|---|---|---|
| commerce-domain | M1–M3, M8; 2.*, 3.*, 4.1–4.2, 9.2 | Integración PostgreSQL, constraints/RLS, concurrencia, estados y snapshots |
| hybrid-retrieval | M4; 5.* | Corpus versionado, ACL, SQL eligibility, recall, citas, retiro e inyección |
| controlled-mcp | M5/M8; 6.*, 9.* | Contratos de ocho tools; consentimiento, tokens, replay, TTL, revocación y atomicidad |
| agent-workflows | M3/M6/M7; 4.3, 7.*, 8.* | Routing, tres workflows, presupuestos, degradación y restart |
| operations-console | M9; 10.* | E2E por rol, estados, teclado, aprobación y reconexión |
| evaluation-observability | M0/M10/M11; 1.*, 11.*, 12.* | Reportes con diez métricas, trazas, seguridad, carga, rollback y restore |

## Checklist documental

- Los nueve puntos solicitados se distribuyen entre design.md y docs/data-model.md, agents-security-mcp.md, rag-evals.md y roadmap.md.
- Los ocho nombres de tools se conservan y tienen clasificación explícita.
- Las acciones privilegiadas requieren aprobación humana externa al agente.
- La investigación no autoriza escrituras por sí sola; request_cancellation no equivale a cancelación efectiva.
- Todos los umbrales son propuestos; fuentes logísticas simuladas están identificadas.
- Sólo las tareas 1.1–1.3 (M0) están marcadas, con la evidencia de la sección "Resultados M0"; el resto permanece sin marcar.

## Gate final del MVP (pendiente)

Todas las tareas completadas con evidencia, escenarios vinculados a tests, gates de docs/rag-evals.md aprobados y demo reproducible. Cualquier lectura/acción indebida bloquea release. El reporte final incluirá commit, entorno, versiones, fixtures, denominadores, fallos y limitaciones conocidas. Sólo tras esta evidencia se archiva el change y se promueven delta specs a especificaciones principales.
