# Verification

## Estado

Completo. Evidencias MEASURED contra PostgreSQL 17 de Compose local (Windows 11, Node 22.23.1), el 2026-10-01.

## Evidencia exigida

Gate de salida (roadmap): Replay/expiry/payload/version/restart/revocation probados; autorización al commit.

Evidencia por capability: Rechazo, expiración, payload alterado, versión stale, replay con otra clave, respuesta perdida tras commit y revocación durante la espera.

## Resultados

Comandos: `pnpm verify` en verde con 167 tests; `pnpm smoke` 17/17 dos veces seguidas; `pnpm openspec:validate` estricto en verde.

| Escenario | Evidencia |
| --- | --- |
| Order already shipped | `packages/domain/test/approvals.test.ts` "refuses an order already in fulfillment…": la orden 401 (FULFILLING) devuelve CONFLICT con `offer: support` y no cambia. |
| Eligible cancellation request | "executes once: changes only status and version, keeps reservations, audits and emits OrderChanged": CANCELLATION_REQUESTED v2, reservas iguales, auditoría `action_requests.create`, `approvals.approve`, `orders.update_order`, `approvals.consume` y un único evento outbox. |
| Agent attempts self-approval | "refuses self-approval, admin approval and any approval without the approver role": requester, support y admin reciben FORBIDDEN; ejecutar sin decisión o con un id inventado → APPROVAL_REQUIRED sin cambios. `apps/api/test/approvals.test.ts`: el requester recibe 403 y un token de audiencia MCP 401 en el endpoint de decisión. M5: `update_order` directo con `_meta.approved` → APPROVAL_REQUIRED. |
| Changed payload or expired approval | "rejection and expiry produce zero domain changes and are terminal" (rechazada, vencida antes de decidir → EXPIRED persistido, vencida antes de ejecutar → EXPIRED persistido, cero ejecuciones). "refuses a changed payload or a changed order…": `reason_code` o `expected_version` distintos → CONFLICT con la aprobación intacta; versión de la orden cambiada → STALE persistido. API: la bandeja marca `stale: true` y la ejecución devuelve 409 sin presentarse como ejecutada. |
| Response lost after commit | "recovers the stored result after a lost response and rejects a replay with a new key": mismo resultado con la misma clave, una sola fila en `action_executions`, versión 2 (no 3). |
| Replay with a new key | Mismo test: otra clave → CONFLICT sin efecto. "lets exactly one of two concurrent executions with different keys succeed". |
| Revoked access during human wait | "does not execute when the requester was revoked after approval" (FORBIDDEN, orden sin cambios; otro usuario con el id → APPROVAL_REQUIRED). `packages/ai/test/graph.test.ts` "does not execute after the requester loses access during the human wait": el run termina `ACCESS_REVOKED`. |
| Continuidad tras reinicio (tarea 1.3) | graph.test "survives a worker restart while waiting for approval and executes the effect once"; `apps/api/test/approvals.test.ts` recorre el caso completo por REST: run WAITING_HUMAN → solicitud del usuario → bandeja del approver → aprobación que reanuda el run → `ACTION_EXECUTED`, mensaje "Cancelación solicitada" (nunca "cancelado") y una sola ejecución. |

## Límites

- GitHub Actions no arranca jobs por facturación de la cuenta; verificación local con los mismos comandos que CI.
