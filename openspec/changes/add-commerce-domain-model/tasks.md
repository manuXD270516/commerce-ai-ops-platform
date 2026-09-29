## 1. M1 — Commerce domain model
- [ ] 1.1 Implementar migraciones, FKs compuestas, importes, snapshots y estados del modelo; probar migración en BD vacía (commerce-domain).
- [ ] 1.2 Implementar identidad/membership, ownership, RLS y fixtures de dos tenants; probar IDs cruzados y pool (commerce-domain, controlled-mcp).
- [ ] 1.3 Implementar outbox/inbox/auditoría/idempotencia; demostrar rollback y deduplicación (commerce-domain, evaluation-observability).

## 2. Verification y cierre
- [ ] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [ ] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
