# controlled-mcp Specification

## Purpose
Superficie de acción de agentes y clientes: ocho tools MCP clasificadas READ, WRITE y PRIVILEGED con schemas estrictos, identidad y scopes verificados en servidor, consentimiento explícito para escrituras, aprobación humana para cambios comerciales, idempotencia y auditoría, sin que annotations ni texto del modelo concedan autoridad.

## Requirements

### Requirement: Classified tool contracts
commerce-mcp-server SHALL exponer search_products, get_product, check_inventory, get_order, get_customer y get_shipping_status como READ; create_support_ticket como WRITE; update_order como PRIVILEGED, con schemas estrictos y validación de permisos en servidor.

#### Scenario: Invalid or excessive arguments
- **WHEN** una tool recibe campos desconocidos, tenant arbitrario, enum inválido o limit >50
- **THEN** devuelve VALIDATION_ERROR sin ejecutar el comando

#### Scenario: Tool annotation is bypassed
- **WHEN** un cliente ignora una annotation y llama directamente una tool privilegiada
- **THEN** el servidor aplica los mismos scopes y requisitos de aprobación

### Requirement: Explicit ticket intent
El sistema SHALL requerir intención explícita verificable, acceso al recurso y guardrails para crear tickets; contenido sensible bloqueado requerirá revisión humana antes de persistirse.

#### Scenario: Investigation without write consent
- **WHEN** el usuario sólo pregunta por un atraso
- **THEN** se puede proponer escalar pero no se crea un ticket automáticamente

#### Scenario: Confirmed ticket and retry
- **WHEN** el usuario confirma el ticket y el cliente repite la llamada con la misma clave y payload
- **THEN** recibe el mismo ticket y se conserva una sola creación
