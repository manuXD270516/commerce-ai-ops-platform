# Verification

## Estado

Completo. Evidencias MEASURED contra PostgreSQL 17 de Compose local y el servidor MCP real en proceso (Windows 11, Node 22.23.1), el 2026-10-01. Sin modelos ni clientes de terceros: el cliente de interoperabilidad es el `Client` oficial de `@modelcontextprotocol/sdk` 1.31.0.

## Evidencia exigida

Gate de salida (roadmap): Contratos cliente-servidor; WRITE sin consentimiento y PRIVILEGED sin aprobación denegados.

Evidencia por capability: Contratos de las ocho tools, interoperabilidad cliente-servidor, acceso directo que ignora annotations y cero efectos sin consentimiento.

## Resultados

Comandos: `pnpm verify` en verde con 130 tests; `pnpm smoke` 16/16 (incluye una llamada MCP autenticada `get_order` contra el build); `pnpm openspec:validate` estricto en verde.

| Escenario | Evidencia |
| --- | --- |
| Contratos e interoperabilidad (tarea 1.1) | `apps/commerce-mcp-server/test/server.test.ts` "interoperates with the official SDK client on the pinned protocol revision": el cliente del SDK negocia `2025-11-25`, lista las ocho tools con su clasificación READ/WRITE/PRIVILEGED y schemas `additionalProperties: false`, y llama `get_order`. `packages/tools/test/scopes.test.ts` fija nombres, clasificación y schemas estrictos. Transporte: 401 sin token o con token de audiencia API, 403 con `Origin` ajeno, 405 en GET, 413 sobre 64 KB. |
| Invalid or excessive arguments | "returns VALIDATION_ERROR without executing for unknown fields, tenant, enums or limit > 50": `limit: 51`, `tenant_id`, categoría fuera del enum, EUR, `price_lt` y `price_lte` juntos y una tool inexistente devuelven VALIDATION_ERROR; el conteo de auditoría `catalog.list` no cambia (ninguna consulta corrió) y cada intento queda como `tool.search_products` DENIED. |
| Tool annotation is bypassed | "applies the same approval requirement when a client calls update_order directly": JSON-RPC crudo con `_meta: { approved: true }` y annotations falsas devuelve APPROVAL_REQUIRED y las órdenes (id, estado, versión) no cambian. "enforces the scope intersection of role and client…": inventory no lee órdenes aunque pida `orders:read`, un token sin `scope` no habilita tools, un cliente limitado a `orders:read` no busca productos y las órdenes ajenas o de otro tenant son NOT_FOUND. |
| Investigation without write consent | "creates no ticket without a recorded consent, even when asked to": tras leer orden y envío, un `consent_id` inventado da `CONSENT_NOT_FOUND` y `confirmed: true` es rechazado por el schema; el conteo de tickets no cambia. `packages/domain/test/ops.test.ts` "requires a recorded consent for tickets…" lo cubre en dominio. |
| Confirmed ticket and retry | "creates one ticket for a confirmed payload and replays it on retry": mismo ticket en el reintento, una sola fila; el consentimiento usado no sirve con otra clave (`CONSENT_ALREADY_USED`) y la misma clave con otro payload da CONFLICT. "binds consent to the exact payload…": payload alterado → `CONSENT_PAYLOAD_MISMATCH`, número de tarjeta → `REQUIRES_HUMAN_REVIEW`, consentimiento de otro subject → `CONSENT_NOT_FOUND`, cero tickets. `apps/api/test/tickets.test.ts` recorre `POST /v1/consents` + `POST /v1/support-tickets` (201 y replay) y rechaza tokens MCP en el endpoint de consentimiento. |
| Minimización y auditoría (tarea 1.2) | "minimizes data by role…": customer sin `on_hand`, support con balances; `get_customer` sólo con id/nombre y el propio registro. "audits every tool call…": una fila `tool.get_order` ALLOWED con el `tool_call_id`, actor y `X-Correlation-Id` de la llamada. "limits ticket creation per subject in PostgreSQL": el sexto ticket en una hora devuelve BUDGET_EXCEEDED. |

## Límites

- La delegación del worker hacia el servidor MCP por red (token en nombre del usuario) no existe todavía: los agentes de M6/M7 usan `invokeTool` en proceso con el mismo enforcement.
- GitHub Actions no arranca jobs por facturación de la cuenta; la verificación es local con los mismos comandos que CI.
