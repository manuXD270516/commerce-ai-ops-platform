## ADDED Requirements

### Requirement: Bounded cancellation transition
El sistema SHALL limitar update_order a request_cancellation de órdenes PLACED o CONFIRMED sin fulfillment iniciado, con expected_version y aprobación válida; no confirmará cancelación logística ni liberará stock por esta solicitud.

#### Scenario: Order already shipped
- **WHEN** se solicita cancelación sobre una orden despachada
- **THEN** devuelve CONFLICT, no cambia estado ni reservas y ofrece soporte

#### Scenario: Eligible cancellation request
- **WHEN** una orden elegible recibe un comando autorizado y aprobado
- **THEN** cambia únicamente a CANCELLATION_REQUESTED, incrementa versión y conserva auditoría y reservas
