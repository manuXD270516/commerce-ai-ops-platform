## ADDED Requirements

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
