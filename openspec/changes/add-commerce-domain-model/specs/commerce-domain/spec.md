## ADDED Requirements

### Requirement: Tenant isolation and resource ownership
El sistema SHALL obtener tenant y sujeto de identidad verificada, aplicar autorización en API/MCP/jobs y prevenir referencias entre tenants mediante constraints y RLS.

#### Scenario: Customer requests another customer's order
- **WHEN** un customer consulta un order_id ajeno, incluso dentro del mismo tenant
- **THEN** recibe NOT_FOUND sin datos de orden, cliente ni shipping y se registra la denegación

#### Scenario: Cross-tenant identifier
- **WHEN** se usa un ID de otro tenant en lectura, escritura o relación de entidades
- **THEN** no se devuelve información ni se confirma ningún cambio
