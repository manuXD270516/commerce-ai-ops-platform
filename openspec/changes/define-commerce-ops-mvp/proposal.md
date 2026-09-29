## Why

Soporte y operaciones necesitan investigar órdenes, recomendar productos elegibles y detectar riesgos de inventario utilizando hechos actuales. Un chatbot sin contratos de dominio, permisos ni evidencia no puede ejecutar estas tareas de forma fiable.

## What Changes

- Definir un MVP completo con consola Next.js, API NestJS, PostgreSQL/pgvector, Redis y workers.
- Establecer contextos de dominio, contratos de datos y workflows verificables para los tres casos prioritarios.
- Exponer ocho tools en `commerce-mcp-server`, con autorización por sujeto, tenant, recurso y acción.
- Integrar búsqueda SQL + semántica, agentes acotados y aprobación persistente para acciones privilegiadas.
- Incluir evals, trazas y una demo cloud reproducible con datos sintéticos.

Este change contiene el contrato del MVP M0–M11. En esta entrega se redactan y revisan los artefactos; todas las tareas de implementación permanecen pendientes.

## Capabilities

### New Capabilities

- `commerce-domain`: catálogo, clientes, órdenes, fulfillment e inventario consistente y aislado.
- `hybrid-retrieval`: recuperación versionada, filtrada y con evidencia.
- `controlled-mcp`: tools, autorización, idempotencia y aprobación humana.
- `agent-workflows`: routing, investigación, recomendaciones y anomalías.
- `operations-console`: consola operacional y seguimiento de acciones.
- `evaluation-observability`: datasets, gates, métricas, auditoría y despliegue verificable.

### Modified Capabilities

Ninguna; proyecto nuevo.

## Impact

Se prevén apps web, API, worker y MCP; contratos compartidos, persistencia relacional, índices semánticos, pipeline de ingesta, CI y despliegue. No se modificará el proyecto vecino. El diseño usa un monolito modular, con procesos separados cuando lo exige el runtime, sin microservicios por especialista.

## Non-goals

Checkout, pagos, reembolsos, compra de productos, modificación de direcciones, ajustes automáticos de stock, reposición autónoma, notificaciones externas reales y multimoneda. `update_order` sólo solicitará cancelación mediante una transición interna aprobada; no confirmará cancelación del transportista. No entrenar modelos ni construir cinco agentes autónomos conversando sin límite.

## Success Criteria

Los tres casos funcionan de extremo a extremo con evidencia; ninguna acción sale de su autorización; una aprobación expirada o reutilizada no produce efectos; la consola muestra datos, riesgos y decisiones fuera del chat. La liberación exige los gates de `docs/rag-evals.md` y evidencia de `verification.md`.
