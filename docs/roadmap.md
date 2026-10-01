# Roadmap del MVP

M0 a M3 completados (2026-09-29) y M4–M11 (2026-10-01). M10 se cerró con excepciones aceptadas por el dueño del repo (ver abajo). M11 cambió de destino a AKS con alcance "listo para desplegar" (decisión del dueño, 2026-10-01): validado localmente y sin costo; el despliegue real en Azure es un paso futuro que requiere autorización. La secuencia expresa dependencias, no estimaciones de calendario. Cada milestone tiene su propio change en `openspec/changes/` con los requisitos que implementa; se archiva sólo cuando sus tareas tienen evidencia. M0 usó `define-commerce-ops-mvp`, que nació como contrato M0–M11 y se dividió tras completarlo. Si cambia alcance o comportamiento, actualizar proposal/spec/design/tasks antes de implementar; una feature adicional lleva nuevo change.

| Milestone (change) | Dependencias | Entregable previsto | Gate de salida / evidencia |
|---|---|---|---|
| M0 Bootstrap (`define-commerce-ops-mvp`, completado) | Diseño revisado | Monorepo TS, Next.js/NestJS/worker/MCP skeleton, entorno local, CI y harness inicial | Arranque reproducible; lint/typecheck/build; smoke con correlación; ningún secreto |
| M1 Commerce domain model (`add-commerce-domain-model`, completado) | M0 | Schema/migraciones, fixtures de dos tenants, estados, RLS y outbox | Migración limpia; invariantes, FKs y aislamiento negativos; snapshots consistentes |
| M2 Catalog API (`add-catalog-api`, completado) | M1 | REST tipado, filtros, cursores, contratos y disponibilidad de lectura | OpenAPI/contract tests; presupuesto estricto, moneda y paginación determinista |
| M3 Orders and inventory (`add-orders-and-inventory`, completado) | M1, M2 | Órdenes, fulfillment, shipping simulado, reserva/movimientos y detector de anomalías | Concurrencia/idempotencia; paquetes parciales; 4 reglas con fixtures y freshness |
| M4 RAG (`add-hybrid-retrieval`, completado) | M2, políticas/fixtures M1 | Ingesta versionada, publicación, ACL, SQL + full-text + pgvector, citas | Recall baseline; no fugas; versiones históricas; no candidatos; retiro/invalidation |
| M5 MCP (`add-controlled-mcp`, completado) | M3, M4 | Ocho tools y permisos/scopes, schemas, auditoría e idempotencia | Contratos cliente-servidor; WRITE sin consentimiento y PRIVILEGED sin aprobación denegados |
| M6 Agent router (`add-agent-router`, completado) | M5 | Selección de proveedor por eval, grafo, routing y presupuestos | Macro-F1 y errores; reanudación durable; supervisor sin reglas de negocio |
| M7 Specialist agents (`add-specialist-agents`, completado) | M6 | Workflows Order, Recommendation, Inventory y auxiliares Catalog/Support | Casos end-to-end con evidencia; guardrails; cero escrituras privilegiadas sin M8 |
| M8 Human approval (`add-human-approval`, completado) | M5, M7 | ActionRequest/Approval, separación de funciones, consumo atómico | Replay/expiry/payload/version/restart/revocation probados; autorización al commit |
| M9 React/Next.js UI (`add-operations-console`, completado) | M2–M8 | Consola operacional, streaming, citas y bandeja de aprobación | E2E por rol; loading/error/empty/degraded; teclado; reconexión; simulaciones visibles |
| M10 Evals (`add-evaluation-gates`, completado con excepciones aceptadas) | Harness desde M0; M4–M9 | Dataset 300, holdout, gates calidad/seguridad/carga y dashboard | Reporte reproducible de diez métricas; todos los gates y limitaciones publicadas |
| M11 Deployment/demo (`add-cloud-deployment-demo`, completado: listo para AKS, despliegue real pendiente de autorización) | M10 | Contenedores, IaC Azure, manifiestos Kubernetes, CI deploy, secretos, runbook, backup/restore y demo | Smoke con 3 casos, rollback y restart; restauración ensayada; costo/latencia etiquetados; AKS validado localmente |

## Excepciones aceptadas

| Fecha | Milestone | Excepción | Siguiente paso |
|---|---|---|---|
| 2026-10-01 | M10 | `intent_routing_macro_f1` 0,936 (gate 0,95) y `retrieval_mrr_at_5` 0,792 (gate 0,8) en holdout | nuevo ciclo de ajuste en dev con holdout nuevo; los umbrales no cambian |
| 2026-10-01 | M10 | Etiquetas sin adjudicación de dos revisores (punto abierto, no realizado) | adjudicación humana |
| 2026-10-01 | M11 | Alcance "listo para desplegar": nada aplicado en Azure | aplicar con autorización, suscripción, región, presupuesto, DNS/TLS y credencial federada ([runbook](runbook.md#aks-listo-para-desplegar-pendiente-de-autorización)) |

M5 publica update_order con ejecución bloqueada mientras no exista aprobación verificable. M7 puede producir propuestas, no saltarse M8. El scaffold visual de M0 no equivale a la consola de M9. Observabilidad y tests acompañan cada milestone; M10 integra evidencia, no inaugura la calidad.

## Demo final prevista

1. Cliente consulta orden con envío parcial atrasado; ve timeline, política aplicable y ticket sólo tras confirmar.
2. Cliente busca notebook de desarrollo por menos de USD 1.500; recibe candidatos elegibles y justificaciones con fichas.
3. Operador ve alerta de stock crítico/discrepancia y evidencia, sin ajuste autónomo.
4. Support solicita cancelación elegible; otro usuario approver revisa; se ejecuta una vez y un replay falla. La UI comunica solicitud pendiente de proceso comercial posterior.
5. Reviewer inspecciona trazas, reporte de evals y etiquetas de datos simulados.
