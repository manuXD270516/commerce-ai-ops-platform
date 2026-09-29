## Context

Milestone M3. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §1, §2 (adaptador logístico simulado) y §4; [agentes y seguridad](../../../docs/agents-security-mcp.md) (reglas de anomalías).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M3: Concurrencia/idempotencia; paquetes parciales; 4 reglas con fixtures y freshness. No objetivos: Transportistas reales, notificaciones externas, explicación de anomalías con LLM (M7) y solicitud de cancelación (M8).

## Decisions

1. **Tracking simulado fuera de orden.** `applyTrackingEvent` bloquea el envío (`FOR UPDATE`), rechaza eventos de otro transportista y registra el evento en inbox con clave `${carrier}:${providerEventId}`: un replay no se aplica. El estado del paquete sólo cambia si el evento es más reciente que `last_observed_at`; un evento viejo se guarda como historia sin retroceder el estado. Todo envío sigue con `source_mode = simulated`.
2. **Frescura con reloj explícito.** `getShippingStatus(db, ctx, orderId, now)` y `detectAnomalies(db, ctx, now)` reciben la hora; los tests usan relojes fijos y órdenes insertadas con `created_at` explícito, sin depender del reloj real.
3. **Reservas y movimientos.** `reserveLastUnits` (roles inventory/support/admin) y `applyStockMovement` (inventory/admin) exigen enteros positivos o deltas enteros, bloquean el balance, verifican `on_hand >= reserved >= 0` y deduplican por `event_id` en inbox. Un rechazo no deja movimiento ni fila de inbox. Cada movimiento publica `InventoryChanged` en outbox y queda auditado.
4. **Dedupe real de alertas.** La migración `0004_anomaly_dedup.sql` reemplaza la unique original, que no deduplicaba cuando algún componente del recurso era NULL, por `UNIQUE NULLS NOT DISTINCT (tenant_id, rule_id, sku_id, warehouse_id, order_id, window_start)`. La inserción es `ON CONFLICT DO NOTHING`, así que corridas concurrentes tampoco duplican.
5. **Ventanas.** Las reglas de stock usan ventanas de 5 minutos, igual que la cadencia del job: una condición que persiste genera una fila por ventana, como fija data-model.md. `unusual_order` usa la ventana de creación de la orden, así que cada línea de orden alerta a lo sumo una vez.
6. **Parámetros de reglas (v1).** critical_stock si `available <= safety_stock`. discrepancy si el último conteo con antigüedad ≤ 72 h difiere de `on_hand`. stockout_risk con demanda de los últimos 7 días excluyendo órdenes CANCELLED: `INSUFFICIENT_DATA` si la cantidad es 0 (`zero_demand`) o hay menos de 3 días con demanda (`few_demand_days`); si no, demanda diaria = cantidad / 7 y alerta si la cobertura es menor que `lead_time_days = 7`. unusual_order evalúa órdenes de los últimos 7 días contra el historial no cancelado del SKU estrictamente anterior, con ≥ 20 observaciones y cantidad > max(10, 3 × mediana). Ningún hallazgo modifica inventario.
7. **Job e identidad de servicio.** El worker registra un job scheduler de BullMQ (`inventory-anomalies`, cada 5 minutos) que recorre los tenants y ejecuta el detector con la identidad explícita `service:anomaly-detector`, rol inventory: puede leer stock y registrar alertas, pero no tiene comandos de órdenes, tickets ni aprobaciones. Un tenant que falla se registra en el log y no detiene a los demás. Sin `DATABASE_URL` el job queda deshabilitado con un aviso.

## Open Questions

Ninguna abierta en docs/. Los parámetros de reglas (safety_stock=5, lead_time_days=7) son fixtures de demo.
