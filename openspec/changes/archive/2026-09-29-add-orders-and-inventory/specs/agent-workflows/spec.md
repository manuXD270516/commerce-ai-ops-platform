## ADDED Requirements

### Requirement: Deterministic inventory anomaly detection
El sistema SHALL detectar critical_stock, discrepancy, unusual_order y stockout_risk con reglas versionadas de docs/agents-security-mcp.md; las alertas serán deduplicadas y no cambiarán inventario.

#### Scenario: Critical stock and discrepancy
- **WHEN** available <= safety_stock y un conteo vigente difiere del balance
- **THEN** se registran ambas evidencias/reglas sin ajustar el saldo automáticamente

#### Scenario: Insufficient historical demand
- **WHEN** faltan observaciones mínimas o la demanda media es cero
- **THEN** se informa INSUFFICIENT_DATA o ausencia de riesgo calculable sin dividir por cero ni inventar una predicción

#### Scenario: Repeated anomaly job
- **WHEN** el mismo recurso incumple la misma regla en la misma ventana y se repite el job
- **THEN** no se duplican alertas efectivas
