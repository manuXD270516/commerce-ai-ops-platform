## Why

El repositorio es público y la evidencia (gates de evaluación, demo, ensayos de recuperación, preparación para AKS) sólo se lee navegando reportes dentro de `openspec/changes/archive`. Un revisor externo necesita verla en una página, sin backend y sin riesgo de publicar datos privados. Pedido del dueño del repo (2026-10-02): publicar con GitHub Pages lo que se pueda publicar.

## What Changes

- Sitio estático de evidencia generado desde la evidencia archivada (`infra/site/build.mjs`): arquitectura, gates de release con estado MEASURED/SIMULATED y excepciones aceptadas, carga, demo y ensayos de recuperación, validación Kubernetes y preparación para AKS, limitaciones.
- El build se niega a escribir la página si encuentra rutas locales, cadenas de conexión, tokens, claves o emails.
- Workflow `pages.yml`: se ejecuta sólo después de que `ci` pase en `main` para el mismo commit; acciones fijadas por SHA (`configure-pages`, `upload-pages-artifact`, `deploy-pages`). CI verifica además que el sitio se construye.

Fuera de alcance: la consola operativa interactiva (requiere API, base de datos y sesión; no hay backend en Pages), datos reales y cualquier servicio pago.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `evaluation-observability`: se agrega el requisito de publicar la evidencia como sitio estático sin datos privados.

## Impact

Nuevos `infra/site/build.mjs` y `.github/workflows/pages.yml`; paso adicional en `ci.yml`. URL: https://manuxd270516.github.io/commerce-ai-ops-platform/.
