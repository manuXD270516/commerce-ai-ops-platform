## Context

Milestone M9. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §2 y §6 (decisiones 4 y 11).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M9: E2E por rol; loading/error/empty/degraded; teclado; reconexión; simulaciones visibles. No objetivos: Chain-of-thought visible y cualquier autoridad de negocio en el cliente.

## Decisions

1. **BFF en Next.js; el navegador nunca ve tokens.** Las páginas son Server Components que llaman a la API con un JWT de 5 minutos firmado para el sujeto de la sesión. Las mutaciones del navegador sólo pasan por route handlers propios (`/api/runs`, `/api/action-requests`, `/api/approvals/:id/decision`, `/api/tickets`) que exigen la cookie de sesión y `Origin` del mismo host (CSRF) y devuelven el status y cuerpo de la API sin reinterpretarlos.
2. **Sesión de demo.** Login local con los seis usuarios de fixtures; cookie HttpOnly, `SameSite=Strict`, `Secure` detrás de TLS (`x-forwarded-proto`), con MAC HMAC-SHA256 derivada de la clave del emisor local para que el navegador no pueda cambiar de sujeto. El rol que muestra la consola es sólo una etiqueta: la API toma el rol de la membership. En cloud se reemplaza por OIDC (M11).
3. **Vistas.** Catálogo con filtros SQL (categoría, precio estricto, RAM) y vacío explícito "no se relajan las condiciones"; órdenes y timeline por paquete con líneas, fecha prometida, atraso, badge "Envío simulado", "Tracking desactualizado" y la regla de escalamiento; inventario con alertas (regla, versión, evidencia) y balances sin datos de clientes; tickets; asistente (inicio de run y detalle); bandeja de aprobación. La navegación por rol es comodidad: la autorización la decide la API (inventory recibe 403 en órdenes y aprobaciones).
4. **Runs en vivo y reconexión.** El detalle de run usa `EventSource` contra un relay SSE del mismo origen que pasa `Last-Event-ID` a la API; el navegador reconecta solo y la API reenvía únicamente lo perdido. Recargar reconstruye la vista desde los eventos persistidos; nada en el cliente crea o reintenta runs. Se muestran hechos con su evidencia, inferencias, incertidumbre, siguientes pasos y la etiqueta "Redacción por plantilla (SIMULATED)"; nunca razonamiento interno. Estados visibles: en cola/ejecutando (loading), esperando decisión humana (pending), completado, parcial/degradado y error.
5. **Acciones honestas.** Confirmar la propuesta crea la solicitud y muestra "pendiente de aprobación por otra persona. Nada se ejecutó todavía". La bandeja muestra recurso, efecto exacto, argumentos canónicos, versión esperada y actual, política, solicitante y vencimiento; tras aprobar dice que la ejecución la valida el servidor, y un conflicto (orden cambiada) se muestra con el código del servidor y "No se ejecutó nada". El resultado ejecutado se rotula "Cancelación solicitada", nunca "pedido cancelado". Crear un ticket es un clic explícito que registra el consentimiento y crea el ticket.
6. **Estados y accesibilidad.** `ApiState` distingue degradado (API inalcanzable o 503), prohibido, no encontrado y error; `loading.tsx`, `error.tsx` y `not-found.tsx` cubren el resto. HTML semántico (tablas con caption por `aria-label`, regiones, `role=status` con `aria-live`), enlace "Saltar al contenido", `:focus-visible` y formularios operables sólo con teclado.
7. **E2E.** Playwright 1.63.0 (`pnpm e2e`) contra los builds reales: API en 3101 con ejecución de runs en proceso, consola en 3100 y una segunda consola en 3102 apuntando a una API caída para el estado degradado; `global-setup` migra y siembra fixtures, corpus y alertas. Usa el canal de navegador instalado (Edge en Windows) para no descargar navegadores; en otras máquinas `PW_CHANNEL=chromium` tras `playwright install chromium`.
8. **API de soporte.** `GET /v1/orders` (lista visible por RLS), estado de envío con fecha prometida, atraso y escalamiento en el contrato `shipping-status.schema.json`, y lectura de órdenes restringida a customer/support/approver (inventory y admin no ven datos de clientes).

## Open Questions

Ninguna para M9.
