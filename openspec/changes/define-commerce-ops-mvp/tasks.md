## 1. M0 — Bootstrap
- [ ] 1.1 Crear monorepo y apps previstas, fijar versiones y lockfile; verificar arranque/build/typecheck (evaluation-observability).
- [ ] 1.2 Configurar entorno local PostgreSQL/pgvector y Redis, secretos de ejemplo y CI; registrar smoke reproducible (evaluation-observability).
- [ ] 1.3 Crear harness de fixtures/evals y tracing inicial con reportes EXPECTED/SIMULATED/MEASURED (evaluation-observability).

## 2. M1 — Commerce domain model
- [ ] 2.1 Implementar migraciones, FKs compuestas, importes, snapshots y estados del modelo; probar migración en BD vacía (commerce-domain).
- [ ] 2.2 Implementar identidad/membership, ownership, RLS y fixtures de dos tenants; probar IDs cruzados y pool (commerce-domain, controlled-mcp).
- [ ] 2.3 Implementar outbox/inbox/auditoría/idempotencia; demostrar rollback y deduplicación (commerce-domain, evaluation-observability).

## 3. M2 — Catalog API
- [ ] 3.1 Implementar contratos REST/OpenAPI, filtros tipados y cursores; probar frontera estricta de USD 1.500 (commerce-domain).
- [ ] 3.2 Implementar detalle y disponibilidad por rol/región; verificar moneda, stock y datos ocultos (commerce-domain).

## 4. M3 — Orders and inventory
- [ ] 4.1 Implementar órdenes, fulfillment y adaptador logístico simulado con eventos fuera de orden; probar envíos parciales/stale (commerce-domain).
- [ ] 4.2 Implementar reservas y movimientos atómicos; probar competencia por última unidad y retries (commerce-domain).
- [ ] 4.3 Implementar detector de cuatro reglas y alertas deduplicadas; probar baja historia y demanda cero (agent-workflows).

## 5. M4 — RAG
- [ ] 5.1 Fijar contrato de embeddings mediante spike, ingesta/versionado/ACL/publicación; probar checksum y retiro (hybrid-retrieval).
- [ ] 5.2 Implementar filtros SQL, vector exacto, full-text/fusión y citas; medir recall y ausencia de fugas (hybrid-retrieval).
- [ ] 5.3 Implementar selección de política contractual, cache aislada y abstención; probar documentos contradictorios/inyección (hybrid-retrieval).

## 6. M5 — MCP
- [ ] 6.1 Implementar ocho tools, transporte autenticado y schemas; fijar versión MCP y probar interoperabilidad (controlled-mcp).
- [ ] 6.2 Implementar scopes, consentimientos, minimización y auditoría; probar acceso directo sin depender de annotations (controlled-mcp).
- [ ] 6.3 Implementar ticket idempotente y contrato privilegiado cerrado sin aprobación válida; probar cero efectos (controlled-mcp).

## 7. M6 — Agent router
- [ ] 7.1 Comparar proveedores/modelos con dataset de desarrollo y registrar selección/versiones (evaluation-observability).
- [ ] 7.2 Implementar router determinístico + clasificador estructurado y aclaraciones; medir macro-F1 (agent-workflows).
- [ ] 7.3 Implementar LangGraph/checkpoints, budgets, cancelación y reanudación autorizada; probar reinicio (agent-workflows).

## 8. M7 — Specialist agents
- [ ] 8.1 Implementar Order + Support con evidencia y reglas de escalamiento; probar missing/stale/partial/lost (agent-workflows).
- [ ] 8.2 Implementar Recommendation + Catalog con filtros, preferencias y revalidación; medir nDCG/eligibilidad (agent-workflows).
- [ ] 8.3 Implementar explicación Inventory sin autoridad de modificación; probar trazabilidad a reglas (agent-workflows).

## 9. M8 — Human approval
- [ ] 9.1 Implementar ActionRequest/Approval y endpoint de decisión con separación de funciones; probar rechazo/expiración (controlled-mcp).
- [ ] 9.2 Implementar update_order acotado y consumo transaccional; probar payload alterado, stale, replay y respuesta perdida (controlled-mcp, commerce-domain).
- [ ] 9.3 Probar revocación durante pausa y continuidad tras reinicio sin doble efecto (controlled-mcp, agent-workflows).

## 10. M9 — UI
- [ ] 10.1 Implementar vistas de catálogo, timeline, alertas, tickets y runs con ACL/estados y etiquetas de simulación (operations-console).
- [ ] 10.2 Implementar revisión de acciones/aprobaciones, SSE/reconexión y navegación por teclado; validar E2E por rol (operations-console).

## 11. M10 — Evals
- [ ] 11.1 Completar 300 casos adjudicados y holdout sellado, baselines y tres repeticiones; registrar métricas y denominadores (evaluation-observability).
- [ ] 11.2 Ejecutar gates de seguridad, calidad, performance y tokens; verificar cero accesos/efectos indebidos y reportar intervalos (evaluation-observability).
- [ ] 11.3 Completar dashboards/trazas y auditar redacción/retención de PII (evaluation-observability).

## 12. M11 — Deployment/demo
- [ ] 12.1 Fijar región/OIDC/presupuesto y verificar compatibilidad cloud; implementar IaC/CI/TLS/secretos y datos privados (evaluation-observability).
- [ ] 12.2 Ejecutar smoke, rollback, reconstrucción de cola y backup/restore aislado; guardar tiempos observados (evaluation-observability).
- [ ] 12.3 Publicar runbook y demo de tres casos más aprobación/replay con datos sintéticos (todas las capabilities).

## 13. Verification y cierre
- [ ] 13.1 Vincular cada escenario spec a tests/reportes y registrar resultados reales en verification.md.
- [ ] 13.2 Validar OpenSpec, revisar diferencias contra contrato, resolver fallos y sólo entonces archivar/sincronizar specs.
