## ADDED Requirements

### Requirement: Deterministic orchestration with bounded specialists
El sistema SHALL resolver reglas, permisos, SLA, cálculos y scheduling fuera del LLM; el Supervisor delegará interpretación y síntesis a especialistas con tools acotadas y salida estructurada.

#### Scenario: Ambiguous order intent
- **WHEN** faltan slots necesarios o hay varias órdenes candidatas
- **THEN** el workflow solicita aclaración sin inventar order_id ni consultar recursos ajenos

### Requirement: Grounded order investigation
El workflow SHALL consultar orden, fulfillment, tracking y política aplicable antes de explicar situación, siguiente acción y escalamiento; distinguirá hechos de inferencias.

#### Scenario: Lost shipment
- **WHEN** el estado logístico autorizado es LOST
- **THEN** muestra evidencia y recomienda escalamiento sin atribuir una causa no registrada ni crear un ticket sin consentimiento

#### Scenario: Stale or unavailable tracking
- **WHEN** tracking excede 6 horas de antigüedad o el proveedor falla
- **THEN** la respuesta muestra timestamp/degradación y no afirma una fecha de entrega como confirmada

#### Scenario: Escalation threshold
- **WHEN** el atraso excede 48 horas o existe DELIVERED_DISPUTED
- **THEN** el resultado señala escalamiento según regla versionada

### Requirement: Eligible product recommendations
El workflow SHALL combinar preferencias, filtros SQL, búsqueda semántica y disponibilidad, devolviendo hasta tres opciones con justificación y evidencia revalidada.

#### Scenario: Stock changes during generation
- **WHEN** un candidato pierde disponibilidad antes de emitir la respuesta
- **THEN** se elimina o se identifica como no disponible, sin recomendarlo como elegible

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

### Requirement: Durable bounded execution
El sistema SHALL conservar checkpoints y estado en PostgreSQL, limitar cada run a 6 llamadas LLM, 12 tools, 12.000 tokens y 60 segundos activos, y revalidar autorización al reanudar.

#### Scenario: Worker restart while awaiting approval
- **WHEN** el worker reinicia durante una espera humana
- **THEN** recupera el run pendiente y no ejecuta ni duplica efectos antes de aprobación válida

#### Scenario: Budget exhausted
- **WHEN** se agota un presupuesto de ejecución
- **THEN** el run termina controladamente con evidencia parcial etiquetada y sin nuevas tool calls
