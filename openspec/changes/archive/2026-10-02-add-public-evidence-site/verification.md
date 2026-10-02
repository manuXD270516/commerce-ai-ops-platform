# Verification

## Estado

Publicado y verificado (2026-10-02): https://manuxd270516.github.io/commerce-ai-ops-platform/ responde 200 con la página de evidencia, desplegada desde el commit `22d28c8`.

## Evidencia exigida

Página pública publicada por `pages.yml` después de un `ci` verde, sin datos privados.

## Resultados

| Escenario | Evidencia | Resultado |
|---|---|---|
| Publication after green CI | `ci` [36979917380](https://github.com/manuXD270516/commerce-ai-ops-platform/actions/runs/36979917380) (checks, smoke, prod-like en verde), después `pages` [36980836328](https://github.com/manuXD270516/commerce-ai-ops-platform/actions/runs/36980836328) (build y deploy en verde), disparado por `workflow_run` sólo con conclusión `success`; la página enlaza a esa corrida de `ci` | pass |
| Private data in the evidence | `infra/site/guard.mjs` con `node --test infra/site/guard.test.mjs` (rutas Windows y de home, cadenas de conexión, bearer tokens, JWK privadas, claves PEM, emails), ejecutado en `checks`; el build termina con error si encuentra alguno. El sitio sólo renderiza campos seleccionados de los reportes JSON, nunca los logs de consola | pass |
| Honest labels | Cada gate muestra MEASURED o SIMULATED; los dos gates de calidad fallidos aparecen como "fail · accepted exception" con la explicación; los gates de seguridad están marcados | pass (revisado en la página publicada) |

Validación local antes de publicar: render revisado en el navegador (modo claro y oscuro), sin unidades duplicadas; `pnpm run format:check`, `lint` y `openspec:validate` en verde.

## Limitaciones

La página muestra la última evidencia archivada (2026-10-01 y 2026-10-02); no se regenera con métricas nuevas salvo que se archive evidencia nueva. La consola interactiva no se publica porque necesita la API y la base de datos.
