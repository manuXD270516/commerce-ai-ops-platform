# commerce-domain Specification

## Purpose
Modelo relacional multi-tenant del dominio de comercio en PostgreSQL: aislamiento por tenant y ownership por cliente mediante constraints compuestas y RLS, snapshots inmutables de compra, e idempotencia, outbox y auditoría transaccionales.

## Requirements

### Requirement: Tenant isolation and resource ownership
El sistema SHALL obtener tenant y sujeto de identidad verificada, aplicar autorización en API/MCP/jobs y prevenir referencias entre tenants mediante constraints y RLS.

#### Scenario: Customer requests another customer's order
- **WHEN** un customer consulta un order_id ajeno, incluso dentro del mismo tenant
- **THEN** recibe NOT_FOUND sin datos de orden, cliente ni shipping y se registra la denegación

#### Scenario: Cross-tenant identifier
- **WHEN** se usa un ID de otro tenant en lectura, escritura o relación de entidades
- **THEN** no se devuelve información ni se confirma ningún cambio

### Requirement: Structured catalog and money
El sistema SHALL representar SKUs con atributos tipados, importes enteros y moneda; aplicar filtros explícitos antes de recomendar.

#### Scenario: Strict budget
- **WHEN** se consulta una notebook por menos de USD 1.500
- **THEN** sólo son elegibles SKUs publicados con currency USD y price_minor <150000
