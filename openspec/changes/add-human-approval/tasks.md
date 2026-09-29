## 1. M8 — Human approval
- [ ] 1.1 Implementar ActionRequest/Approval y endpoint de decisión con separación de funciones; probar rechazo/expiración (controlled-mcp).
- [ ] 1.2 Implementar update_order acotado y consumo transaccional; probar payload alterado, stale, replay y respuesta perdida (controlled-mcp, commerce-domain).
- [ ] 1.3 Probar revocación durante pausa y continuidad tras reinicio sin doble efecto (controlled-mcp, agent-workflows).

## 2. Verification y cierre
- [ ] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [ ] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
