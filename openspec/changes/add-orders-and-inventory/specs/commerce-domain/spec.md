## ADDED Requirements

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
