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

Realizada el 2026-09-29, requisito "Diseño revisado" de M0 en docs/roadmap.md. Alcance: coherencia entre design.md, docs/ y specs, y decisiones que bloqueaban el bootstrap (gestor y workspaces, runtime, versiones de Next.js/NestJS/LangGraph JS, persistencia y migraciones, formato de contratos, estrategia de tests, observabilidad, entorno local y CI). Resultado: 16 decisiones registradas en design.md §6, ninguna altera comportamiento ni alcance funcional. Pendiente derivado, resuelto en la división del change: el escenario "Documentation-only delivery" se reemplazó por el requisito reformulado "Spec-driven change lifecycle".

## Trazabilidad de escenarios

| Escenario | Evidencia |
|---|---|
| Clean clone | Tabla "Resultados M0": clone limpio en Windows y contenedor Linux, todos los comandos con exit 0 |
| Correlated request | `infra/scripts/smoke.mjs`: 20/20 con el mismo `correlation_id` y `trace_id` en logs de web y API; traza con spans de `web` y `api` en Jaeger; `apps/api/test/api.test.ts` y `apps/web/test/api-status.test.ts` |
| Untrusted correlation id | Smoke ("malformed correlation id never reaches logs"); `packages/contracts/test/contracts.test.ts`; `apps/api/test/api.test.ts` |
| Evaluation report labels | `evals/test/harness.test.ts` ("rejects a simulated run that claims MEASURED results"); reporte `simulated-selftest` |
| No secrets in the repository | `gitleaks git` 8.30.1 sin hallazgos; `.env.example` con valores `local-only-not-a-secret`; job `checks` de CI incluye el escaneo |
| Milestone not started | Los once changes `add-*` tienen tareas sin marcar y verification.md con estado "No iniciado" |
| Archiving a change | Este change: tareas 1.1–2.2 marcadas con la evidencia de este documento y `openspec validate --all --strict` sin errores antes de archivar |

## División del change (2026-09-29)

El change nació como contrato M0–M11. Tras M0 se trasladaron sin cambios de texto 25 requisitos y 31 tareas a once changes de milestone (comprobado mecánicamente contra el commit anterior); los IDs originales de tareas figuran en la sección Impact de cada proposal. Aquí sólo quedan M0, el requisito de ciclo de vida reformulado y un requisito nuevo de bootstrap reproducible que recoge el gate de M0 del roadmap. Arquitectura y alcance pasaron a `docs/architecture.md` y `docs/mvp-scope.md` como documentos vivos.