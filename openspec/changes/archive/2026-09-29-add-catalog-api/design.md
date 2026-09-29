## Context

Milestone M2. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §4 (interfaces) y §6 (decisiones 5 y 8).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M2: OpenAPI/contract tests; presupuesto estricto, moneda y paginación determinista. No objetivos: búsqueda semántica (M4), órdenes e inventario transaccional (M3) y vistas de consola (M9).

## Decisions

Ninguna cambia el comportamiento ni el alcance del MVP. La 1 adelanta a M2 la verificación de identidad que architecture.md exige en todos los puntos de entrada (OIDC). Sin ella, la primera API pública habría confiado en cabeceras falsificables.

| # | Tema | Decisión | Justificación |
|---|---|---|---|
| 1 | Identidad | `Authorization: Bearer <JWT ES256>` verificado con `node:crypto`: firma contra JWKS, `iss`, `aud`, `exp`, `iat`, `nbf`, vida máxima de 1 h y claims `sub` y `tenant_id` (UUID). Hay audiencias separadas: `commerce-api` y `commerce-mcp`. El rol sale de `memberships`, nunca del token. En local, `pnpm auth:init` genera las claves de un issuer de desarrollo en `.local/auth` (git-ignored); la consola firma tokens de 5 min para los usuarios de demo. En cloud (M11) el JWKS lo publica el proveedor OIDC. Se eliminan `X-Tenant-Id` y `X-Subject-Id` | Cumple “tenant de identidad verificada”, “audience/issuer/expiry verificados” y “no token passthrough” (agents-security-mcp.md); sin dependencias nuevas |
| 2 | Errores | 401 `UNAUTHENTICATED` (nuevo código), 403 `FORBIDDEN` (sin membership en el tenant del token), 400 `VALIDATION_ERROR`, 404 `NOT_FOUND`. Toda respuesta de error, incluidas rutas inexistentes y excepciones de Nest, sigue `error.schema.json` | Errores estables sin detalles internos |
| 3 | Filtros | Parser estricto: se rechazan parámetros desconocidos o repetidos (p. ej. `tenant_id`), números no enteros o negativos, `limit` fuera de 1–50 y moneda distinta de USD. `price_lt` son unidades menores con comparación estricta (`price_minor < price_lt`). El dominio repite las validaciones | Presupuesto estricto y ningún filtro ignorado en silencio |
| 4 | Paginación | Orden total `(price_minor, sku_code)` ascendente; el cursor opaco base64url codifica la última tupla y se consulta con comparación de filas. `limit` 20 por defecto, máximo 50 | Determinista, sin huecos ni duplicados |
| 5 | Visibilidad | El catálogo sólo lista productos `published` del tenant. En inventario, customer y approver ven `available` y región; inventory, support y admin ven además `on_hand`, `reserved` y `safety_stock`. Sólo inventory y admin ven SKUs no publicados. El stock se suma por región; si un SKU tiene varias regiones y no se pasa `region`, responde 400. Borradores y otros tenants responden 404 con auditoría `DENIED` | “Visibilidad por rol y región sin datos ocultos”; no confirma existencia |
| 6 | Fixture | `commerce-domain` 0.2.0 añade un producto `draft` (`NB-PROTO-16`) y un SKU a exactamente USD 1.500 (`NB-DEV-32X`, 150000). La 0.1.0 queda inmutable para la evidencia de M1 | Casos negativos de frontera y de datos ocultos |
| 7 | Contract tests | Tests de integración NestJS contra PostgreSQL real que validan cada respuesta con Ajv contra los schemas. `pnpm test` corre los paquetes en serie porque dominio y API siembran la misma BD | Evita tests intermitentes por `TRUNCATE` concurrente |

## Open Questions

Ninguna.
