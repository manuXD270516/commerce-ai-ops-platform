## Context

Milestone M8. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §4; [agentes y seguridad](../../../docs/agents-security-mcp.md) (aprobación y replay); [modelo de datos](../../../docs/data-model.md) (estados).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M8: Replay/expiry/payload/version/restart/revocation probados; autorización al commit. No objetivos: Cancelación efectiva, liberación de reservas, reembolsos y confirmación del transportista.

## Decisions

1. **Payload canónico.** El único comando es `{order_id, action: request_cancellation, reason_code, expected_version}`; `reason_code` es un enum cerrado. Su sha256 (serialización estable) se guarda en el ActionRequest y se copia en la Approval; la ejecución recalcula el hash del comando recibido y debe coincidir con ambos.
2. **ActionRequest = confirmación del usuario.** `POST /v1/action-requests` (token de audiencia API del propio usuario, rol customer o support, `Idempotency-Key` obligatorio) crea la solicitud PENDING con requester, tenant (RLS), recurso, tool, hash, `expected_version`, `policy_version` y TTL de 15 minutos (`APPROVAL_TTL_MS`, antes 30 min por error). Rechaza de entrada órdenes ajenas (NOT_FOUND por RLS), versión distinta (CONFLICT) y órdenes no elegibles (CONFLICT con `offer: support`). Si viene de un run, el run debe ser del mismo usuario.
3. **Decisión humana.** `POST /v1/approvals/:id/decision` sólo para el rol approver; requester, support y admin reciben FORBIDDEN (admin no aprueba implícitamente) y no existe tool de aprobación. Una única decisión por solicitud (unique en `approvals`, migración `0008_approvals.sql`, lock `FOR UPDATE`); REJECTED y EXPIRED son terminales. La bandeja (`GET /v1/action-requests`) muestra recurso, efecto exacto, argumentos canónicos, versión esperada y actual, `stale`, expiración y decisión.
4. **Ejecución atómica y única.** `executeUpdateOrder` corre dentro de `commitIdempotent`: lock advisory por clave de idempotencia (un retry concurrente espera y reproduce), lock de la solicitud, membership vigente del requester, solicitud APPROVED con aprobación de otro sujeto, TTL, hash, lock de la orden, versión y elegibilidad; luego, en la misma transacción, transición a CANCELLATION_REQUESTED con versión + 1, `action_executions` (unique por solicitud: consumo), estado EXECUTED, outbox `OrderChanged`, auditoría del efecto y del consumo, y registro de idempotencia. Reservas y fulfillment no se tocan.
5. **Rechazos que persisten.** Expiración, cambio de versión de la orden e inelegibilidad se registran (EXPIRED, STALE, FAILED) en una unidad de trabajo separada después del rollback, con auditoría DENIED; un payload alterado se rechaza sin invalidar la aprobación legítima (sólo el requester puede intentar ejecutar). Reintento con la misma clave → mismo resultado; otra clave → CONFLICT (aprobación consumida).
6. **Ejecución desde el run.** La aprobación despacha la reanudación del run; el executor (M6) re-resuelve la membership del dueño, lee la decisión de la BD y llama `update_order` por `@commerce/tools` con la clave `run-<id>`. El mismo comando está disponible para el requester por `POST /v1/orders/:id/actions` con el mismo enforcement.
7. **Identidad en cada entrada.** API y MCP verifican firma, emisor, audiencia (tokens de otra audiencia → 401), vigencia y, en MCP, scopes; la membership se relee en cada request y en cada reanudación.

## Open Questions

Ninguna para M8. La cancelación efectiva, la liberación de reservas y el reembolso siguen fuera del MVP.
