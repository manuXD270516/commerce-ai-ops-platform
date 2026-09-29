## ADDED Requirements

### Requirement: Operational views beyond chat
La consola Next.js SHALL ofrecer catálogo con filtros, investigación de orden/timeline, alertas de inventario, tickets, detalle de run/evidencias y bandeja de aprobaciones según rol.

#### Scenario: Inventory operator opens dashboard
- **WHEN** un usuario inventory inicia sesión
- **THEN** puede consultar balances y anomalías autorizadas sin obtener datos privados de clientes ni funciones de aprobación

### Requirement: Reviewable action approval
La UI SHALL mostrar recurso, efecto exacto, argumentos, evidencia, versión y expiración antes de aprobar/rechazar; el backend será la autoridad final.

#### Scenario: Approval becomes stale
- **WHEN** la orden cambia después de abrir la pantalla
- **THEN** se muestra el conflicto devuelto por servidor y no se presenta la acción como ejecutada

### Requirement: Recoverable and honest user experience
La UI SHALL soportar estados loading/empty/error/degraded/pending/completed, reconexión SSE, navegación por teclado y etiquetas de datos simulados; no mostrará chain-of-thought ni éxito anticipado de una mutación.

#### Scenario: Browser disconnects
- **WHEN** se interrumpe y restablece la conexión durante un run
- **THEN** la UI recupera su estado persistido sin iniciar otra ejecución por defecto

#### Scenario: Cancellation was only requested
- **WHEN** update_order concluye correctamente
- **THEN** la UI muestra “cancelación solicitada” y no “pedido cancelado”
