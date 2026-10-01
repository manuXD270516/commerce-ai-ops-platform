# agent-workflows Specification

## Purpose
Flujos operativos sobre el dominio de comercio: detección determinística de anomalías de inventario y, en milestones posteriores, routing, investigación y recomendaciones por agentes con evidencia verificable.

## Requirements

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

### Requirement: Deterministic orchestration with bounded specialists
El sistema SHALL resolver reglas, permisos, SLA, cálculos y scheduling fuera del LLM; el Supervisor delegará interpretación y síntesis a especialistas con tools acotadas y salida estructurada.

#### Scenario: Ambiguous order intent
- **WHEN** faltan slots necesarios o hay varias órdenes candidatas
- **THEN** el workflow solicita aclaración sin inventar order_id ni consultar recursos ajenos

### Requirement: Durable bounded execution
El sistema SHALL conservar checkpoints y estado en PostgreSQL, limitar cada run a 6 llamadas LLM, 12 tools, 12.000 tokens y 60 segundos activos, y revalidar autorización al reanudar.

#### Scenario: Worker restart while awaiting approval
- **WHEN** el worker reinicia durante una espera humana
- **THEN** recupera el run pendiente y no ejecuta ni duplica efectos antes de aprobación válida

#### Scenario: Budget exhausted
- **WHEN** se agota un presupuesto de ejecución
- **THEN** el run termina controladamente con evidencia parcial etiquetada y sin nuevas tool calls
