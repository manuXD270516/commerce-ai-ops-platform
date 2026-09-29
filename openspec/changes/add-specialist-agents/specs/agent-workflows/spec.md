## ADDED Requirements

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
