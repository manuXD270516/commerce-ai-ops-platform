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

### Requirement: Atomic inventory invariants
El sistema SHALL preservar on_hand >= reserved >= 0 con reservas, movimientos y balance atómicos, idempotentes y versionados.

#### Scenario: Concurrent reservation
- **WHEN** dos reservas compiten por la última unidad
- **THEN** una confirma y otra falla por disponibilidad, sin saldo negativo ni movimiento parcial

#### Scenario: Duplicate inventory event
- **WHEN** un consumidor recibe dos veces el mismo event_id
- **THEN** se conserva un único efecto de stock y un único movimiento efectivo

### Requirement: Order and fulfillment evidence
El sistema SHALL conservar snapshots de compra, fulfillment por línea y tracking por paquete con fuente y timestamp.

#### Scenario: Partial shipment
- **WHEN** una orden tiene un paquete entregado y otro atrasado
- **THEN** get_order y get_shipping_status permiten identificar las líneas y estados de ambos sin declarar toda la orden entregada

### Requirement: Bounded cancellation transition
El sistema SHALL limitar update_order a request_cancellation de órdenes PLACED o CONFIRMED sin fulfillment iniciado, con expected_version y aprobación válida; no confirmará cancelación logística ni liberará stock por esta solicitud.

#### Scenario: Order already shipped
- **WHEN** se solicita cancelación sobre una orden despachada
- **THEN** devuelve CONFLICT, no cambia estado ni reservas y ofrece soporte

#### Scenario: Eligible cancellation request
- **WHEN** una orden elegible recibe un comando autorizado y aprobado
- **THEN** cambia únicamente a CANCELLATION_REQUESTED, incrementa versión y conserva auditoría y reservas
