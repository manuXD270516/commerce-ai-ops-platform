## Context

Repositorio público desde 2026-10-02, con GitHub Actions disponible. La evidencia de M10 y M11 está archivada como reportes JSON/Markdown dentro de cada change.

## Goals / Non-Goals

Objetivo: una página pública, legible y honesta con la evidencia existente. No objetivos: ejecutar la consola sin backend, recalcular métricas, mostrar datos que no estén ya en la evidencia archivada.

## Decisions

1. **Página de evidencia, no consola en modo demo.** La consola depende de la API, de la base de datos y de una sesión firmada; un modo estático necesitaría un segundo frontend con datos grabados que divergiría del real. La página muestra lo medido y enlaza al código.
2. **Fuente única: evidencia archivada.** `infra/site/build.mjs` (Node, sin dependencias) lee los reportes más recientes de `openspec/changes/archive/2026-10-01-add-evaluation-gates/evidence` y `.../2026-10-01-add-cloud-deployment-demo/evidence` y renderiza sólo campos seleccionados (métrica, valor, unidad, n, umbral, estado, resultado). No lee los logs de consola, que contienen rutas locales.
3. **Barrera contra datos privados.** Antes de escribir, el build busca rutas de Windows o de home, cadenas `postgres://`/`redis://`, bearer tokens, JWK privadas, claves PEM y emails; si encuentra alguno, termina con error y no publica.
4. **Publicación después de CI.** `pages.yml` se dispara con `workflow_run` de `ci` en `main` y sólo continúa si terminó con éxito; construye desde el mismo commit (`head_sha`), enlaza a esa corrida y despliega con `deploy-pages` (permisos `pages: write`, `id-token: write` sólo en el job de deploy). Acciones fijadas por SHA. `ci` construye el sitio en `checks` para fallar antes si algo cambia.
5. **Presentación.** HTML y CSS en línea, sin recursos externos, modo claro/oscuro, tablas con desplazamiento horizontal en pantallas chicas, etiquetas MEASURED/SIMULATED y excepciones aceptadas visibles.

## Open Questions

Ninguna.
