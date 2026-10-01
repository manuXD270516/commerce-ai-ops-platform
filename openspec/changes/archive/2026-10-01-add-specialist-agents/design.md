## Context

Milestone M7. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §3; [agentes y seguridad](../../../docs/agents-security-mcp.md) (workflows prioritarios).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M7: Casos end-to-end con evidencia; guardrails; cero escrituras privilegiadas sin M8. No objetivos: Escrituras privilegiadas (M8) y vistas de consola (M9).

## Decisions

1. **Especialistas como funciones del grafo, no servicios.** `investigateOrder` (Order + paso Support), `recommendProductsForRun` (Recommendation + paso Catalog) y `explainInventory` viven en `packages/ai/src/graph/specialists.ts` y sólo acceden a datos por `ToolGateway` (tools M5 con el perfil del especialista) o por recuperación autorizada (M4). Devuelven un `SpecialistFinding` estructurado: hechos con su evidencia (kind, ref, versión, observed_at, fuente sql/knowledge), inferencias rotuladas, incertidumbre, siguientes pasos, escalamiento y, si corresponde, una propuesta. La síntesis (`template-synth.v1`, SIMULATED) sólo redacta ese contenido; no agrega hechos.
2. **Regla de escalamiento versionada en dominio.** `assessEscalation` (`escalation.v1`, `packages/domain/src/fulfillment.ts`) escala si un paquete está LOST, DELIVERED_DISPUTED o supera 48 h de atraso sobre su fecha prometida. El dominio calcula `estimatedDeliveryAt`, `delayHours` y `stale` (> 6 h sin observación) y `get_shipping_status` los publica; el especialista los informa sin recalcular. El fixture `commerce-domain@0.3.0` agrega fechas prometidas a los paquetes de la orden 401.
3. **Order + Support.** Lee orden, todos los paquetes con sus líneas y la política de envíos vigente a la fecha de compra. Paquete LOST: hecho + escalamiento, y la incertidumbre dice explícitamente que no hay causa registrada. Tracking stale: muestra el timestamp y no confirma fecha. Proveedor/tool caído: hallazgo `partial` sin fechas. Orden inexistente o ajena: `not_found` sin otros datos. Ticket: sólo se ofrece ("sólo lo creo si lo confirmás"); crearlo requiere el consentimiento de M5. Cancelación: propuesta con `expected_version` y precondición advisory (PLACED/CONFIRMED sin despacho); la ejecución y su autoridad son M8.
4. **Recommendation + Catalog.** Elegibilidad sólo por SQL vía `search_products` (USD, categoría, `price_lt`/`price_lte` según "menos de"/"hasta", RAM exacta, stock > 0 en la región). Las fichas de producto (retrieval restringido a los productos elegibles) ordenan; "desarrollo/programar/Docker" es preferencia blanda (más RAM primero) y nunca agrega requisitos. Hasta tres opciones; justo antes de responder `check_inventory` revalida y un SKU sin disponibilidad se elimina y se informa. Sin candidatos: `no_candidates` con las restricciones intactas y pregunta por flexibilizar.
5. **Inventory.** Explica alertas del detector determinístico (M3) citando regla, versión y la evidencia registrada (texto derivado de los campos de la regla, no de un modelo), más el balance actual vía `check_inventory`. Su perfil (`inventory:read`, `catalog:read`) no tiene ninguna tool de escritura y el router rechaza pedidos de ajustar stock. Un customer recibe `forbidden`.
6. **Evaluación de recomendaciones.** Dataset `recommendation@0.1.0` (10 consultas, relevancia graduada 0–3 por SKU). La suite reinicia catálogo y corpus a sus fixtures, ejecuta el especialista real y mide nDCG@3, la proporción de SKUs recomendados que pasan un predicado SQL independiente de elegibilidad y la abstención correcta cuando no hay candidatos.

## Risks / Trade-offs

- El catálogo de demo tiene cuatro notebooks y un mouse: nDCG@3 no discrimina mucho y las etiquetas las escribió el mismo autor que conoce la lógica de ranking.
- La redacción es por plantilla; un modelo real podría redactar mejor pero debe recibir lo mismo (hechos con evidencia) y no puede agregar autoridad.

## Open Questions

Ninguna para M7.
