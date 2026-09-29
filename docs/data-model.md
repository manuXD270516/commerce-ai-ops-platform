# Modelo de datos del MVP

Modelo lógico; no contiene DDL ni migraciones ejecutables. PostgreSQL es la fuente de verdad. PK UUID; timestamps UTC; cantidades enteras; importes en centavos BIGINT + currency ISO (USD en MVP). Nunca float para dinero. Cada tabla de negocio lleva tenant_id y claves únicas `(tenant_id, id)` para FKs compuestas que impidan referencias entre tenants.

| Contexto / entidad | Campos relevantes y relaciones | Invariantes |
|---|---|---|
| Access: Tenant, Membership | subject_id OIDC, tenant_id, role, enabled | Tenant activo derivado de sesión y membership; no del prompt |
| Customers: Customer | id, subject_id opcional, nombre, email cifrado | Unique tenant+subject cuando existe; perfil mínimo por scope |
| Catalog: Product | id, title, category, description, status | Sólo published entra en recomendaciones |
| Catalog: SKU | product_id, sku_code, price_minor, currency, brand, cpu_family, ram_gb, storage_gb, gpu, weight_grams, version | Unique tenant+sku_code; precio >= 0; atributos de filtrado tipados |
| Catalog: ProductAttribute | product_id/sku_id, key, value, unit | Extensiones JSON validadas; no reemplazan columnas de filtros frecuentes |
| Inventory: Warehouse | id, name, region | Región determina stock elegible |
| Inventory: StockBalance | sku_id, warehouse_id, on_hand, reserved, safety_stock, version | Unique tenant+sku+warehouse; on_hand >= reserved >= 0 |
| Inventory: Reservation | order_id, order_item_id, sku_id, warehouse_id, quantity, status, expires_at | quantity > 0; reserve/release idempotente y atómico |
| Inventory: StockMovement | balance_id, delta_on_hand, delta_reserved, reason, reference_id, recorded_at | Append-only; reference_id único por operación; saldo reconciliable |
| Inventory: StockObservation | sku_id, warehouse_id, counted_quantity, observed_at, source | Conteo externo simulado no sobreescribe saldo; detecta discrepancia |
| Orders: Order | customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor, version | Total derivado y validado; moneda única por orden |
| Orders: OrderItem | order_id, sku_id, quantity, unit_price_minor, title_snapshot, attributes_snapshot | quantity > 0; conserva precio y descripción comprados |
| Fulfillment: Fulfillment, FulfillmentItem | order_id, status; fulfillment_id, order_item_id, quantity | Admite envíos parciales; suma por línea no supera cantidad ordenada |
| Fulfillment: Shipment | fulfillment_id, carrier, tracking_ref, status, estimated_delivery_at, last_observed_at, source_mode | source_mode=simulated visible en demo |
| Fulfillment: TrackingEvent | shipment_id, provider_event_id, status, occurred_at, received_at | Unique tenant+carrier+provider_event_id; eventos tardíos no regresan estado |
| Support: Ticket | customer_id, order_id opcional, category, status, summary, evidence_refs, created_by | Idempotencia; relación order/customer del mismo tenant validada |
| Knowledge: Document, DocumentVersion | kind, source_uri, product_id opcional; checksum, version, status, locale, region, valid_from, valid_to, ACL | Versiones inmutables; publicación atómica, vigencia por intervalo |
| Knowledge: Chunk | document_version_id, ordinal, text, section, token_count, embedding, embedding_model, embedding_version | Dimensión fija por índice; nunca mezclar espacios de embeddings |
| AI: AgentRun, RunEvent, Checkpoint | subject_id, customer_id opcional, intent, status, budgets, prompt/model_version; run_id, seq, data | Contexto autorizado obligatorio al reanudar; eventos ordenados y redactados |
| AI: Evidence | run_id, kind, resource_ref, version, observed_at, document_version_id opcional | Citas resolubles sólo por lectores autorizados |
| Governance: ActionRequest | requester, tool, resource_id, canonical_args_hash, expected_version, expires_at, status | Payload inmutable; cambios requieren nueva solicitud |
| Governance: Approval | action_request_id, approver, decision, reason, decided_at, expires_at | Una decisión efectiva; approver distinto de requester |
| Governance: ActionExecution | action_request_id, idempotency_key, result_ref, status | Una ejecución efectiva por solicitud |
| Governance: AuditEvent | actor, tenant, action, resource, outcome, policy_version, correlation_id, timestamp | Append-only; sin PII libre ni secretos |
| Infrastructure: Outbox, Inbox, IdempotencyRecord | event_id, aggregate_version, payload/version, status; consumer+event_id; subject+key+payload_hash | Entrega al menos una vez; efectos deduplicados |
| Inventory: Anomaly | sku/warehouse/order, rule_id, rule_version, severity, evidence, window_start, status | Unique tenant+rule+resource+window; ack no modifica stock |

## Relaciones principales

Customer 1:N Order; Product 1:N SKU; SKU N:M Warehouse vía StockBalance. Order 1:N OrderItem y Fulfillment; Fulfillment N:M OrderItem vía FulfillmentItem; Fulfillment 1:N Shipment; Shipment 1:N TrackingEvent. Document 1:N DocumentVersion 1:N Chunk. AgentRun 1:N Evidence y ActionRequest; ActionRequest 0..1 Approval efectiva y 0..1 ActionExecution efectiva.

## Estados y concurrencia

Orden: `PLACED → CONFIRMED → FULFILLING → SHIPPED → DELIVERED`. `PLACED|CONFIRMED → CANCELLATION_REQUESTED` es la única mutación expuesta por update_order. No hay transición a CANCELLED en el MVP: solicitar no equivale a cancelar ni libera reservas. Si una orden ya fue despachada, cambió de versión o tiene fulfillment iniciado, se rechaza y se ofrece soporte. Las demás transiciones provienen de fixtures/integración simulada autenticada, no del agente.

Reservas: ACTIVE → RELEASED|CONSUMED|EXPIRED; actualización condicional de balance y movimiento en una sola transacción. `available = on_hand - reserved`; safety_stock determina riesgo, no modifica ese cálculo. Reserva concurrente exige disponibilidad suficiente bajo bloqueo/UPDATE condicional; rollback completo ante fallo. No se permite stock negativo para representar discrepancias: StockObservation conserva el dato discrepante y genera alerta.

ActionRequest: PENDING → APPROVED|REJECTED|EXPIRED; APPROVED → EXECUTED|STALE|EXPIRED|FAILED. Consumo de aprobación, cambio de orden, resultado idempotente y auditoría se confirman juntos. Un fallo transitorio previo a commit permite retry con la misma clave; no permite doble efecto. Rechazo y expiración son terminales.

## Índices, aislamiento y ciclo de vida

Índices B-tree para tenant+status+created_at, tenant+customer+order, tenant+category+currency+price, tenant+sku+warehouse y tenant+shipment+occurred_at. Índice full-text de contenido; vector exacto inicialmente. Índices parciales para outbox pendiente y solicitudes abiertas.

RLS por tenant en tablas de negocio, con contexto transaccional obtenido de identidad verificada; rol runtime sin BYPASSRLS y sin ownership de tablas. Política adicional de ownership limita customer a sus órdenes. Pool limpia contexto al finalizar transacción. Migrator separado del runtime. Constraints y tests negativos cubren aislamiento en APIs, MCP, retrieval y jobs.

Retención propuesta para demo: runs/checkpoints 30 días, logs redactados 14 días, auditoría/aprobaciones 90 días; documentos activos mientras estén publicados. Limpieza explícita de sesiones y corpus al reset de demo. En producción, retención y borrado se redefinen según requisitos del comercio antes de admitir PII real. Backups tienen ciclo documentado y se ensaya restauración en M11.
