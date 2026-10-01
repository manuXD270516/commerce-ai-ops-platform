# Verification

## Estado

Completo. E2E MEASURED con Playwright 1.63.0 y Microsoft Edge (canal instalado) contra los builds de API y consola y PostgreSQL 17 de Compose (Windows 11, Node 22.23.1), el 2026-10-01.

## Evidencia exigida

Gate de salida (roadmap): E2E por rol; loading/error/empty/degraded; teclado; reconexión; simulaciones visibles.

Evidencia por capability: E2E por rol, estados de carga/error/vacío/degradado, teclado, aprobación stale y reconexión SSE.

## Resultados

Comandos: `pnpm e2e` 8/8 (dos corridas seguidas); `pnpm verify` en verde con 168 tests; `pnpm smoke` 17/17 dos veces (el chequeo de catálogo ahora inicia sesión en la consola); `pnpm openspec:validate` estricto en verde.

| Escenario | Evidencia (`apps/web/e2e/console.spec.ts`) |
| --- | --- |
| Inventory operator opens dashboard | "inventory operator: balances and alerts, no customer data and no approval functions": alertas (`critical_stock`, regla y versión) y balances visibles; sin nombres ni emails de clientes en la vista; sin enlaces de órdenes ni aprobaciones; `/approvals` → prohibido y sin botón "Aprobar"; una orden → prohibido/no encontrado (la API ahora niega órdenes a inventory). |
| Approval becomes stale | "approver: a request whose order changed after opening the screen shows the server conflict": el approver abre la bandeja, la orden cambia de versión, "Aprobar" muestra `CONFLICT … No se ejecutó nada` y la orden queda CONFIRMED v2. |
| Browser disconnects | "reconnection: reloading a run replays persisted events and never starts another run": recarga y corte de red (offline/online) reconstruyen el resultado desde los eventos persistidos y el conteo de `agent_runs` no cambia. `apps/api/test/runs.test.ts` cubre el reenvío con `Last-Event-ID`. |
| Cancellation was only requested | "cancellation: proposal, user confirmation, approver decision, shown as requested not cancelled": run WAITING_HUMAN con propuesta, confirmación del cliente, bandeja con efecto, argumentos y vencimiento, aprobación desde otra sesión, outcome `ACTION_EXECUTED` con "Cancelación solicitada" y sin "pedido cancelado"; orden CANCELLATION_REQUESTED v2. |
| Vistas por rol y simulaciones visibles (tarea 1.1) | "customer: catalog filters, timeline with simulated and stale labels…": filtro `< USD 1.500` sin NB-DEV-32X ni NB-WS-64, dos paquetes con "Envío simulado", "Tracking desactualizado" y escalamiento `escalation.v1`; orden ajena → no encontrada; inventario → prohibido. "customer: streamed answer with evidence…": hechos con evidencia, etiqueta SIMULATED, sin razonamiento interno, y el ticket existe sólo después del clic. |
| Estados y teclado (tarea 1.2) | "states: empty results, pending run, and a degraded console when the API is down": vacío explícito y consola con API caída → "Servicio degradado". El estado pending (esperando decisión humana) se verifica en el caso de cancelación. "keyboard only…": login, enlace de salto, consulta y envío sólo con teclado hasta la aclaración. |

## Límites

- La sesión de demo firma tokens localmente; en cloud debe reemplazarse por OIDC (M11).
- El SSE se sirve por polling a la base cada 400 ms; adecuado para la demo, no medido bajo carga.
- E2E no corre en GitHub Actions (facturación bloqueada); el workflow quedó preparado con `PW_CHANNEL=chromium` e instalación de Chromium.
