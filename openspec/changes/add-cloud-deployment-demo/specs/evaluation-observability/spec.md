## ADDED Requirements

### Requirement: Resilient deployment and recovery
El MVP SHALL tener un entorno local reproducible y demo cloud con TLS, servicios de datos privados, secretos administrados, health/readiness, migraciones controladas y ensayo de recuperación.

#### Scenario: Redis restart
- **WHEN** se pierde estado de coordinación de Redis
- **THEN** outbox/runs durables permiten reconstruir trabajo sin perder aprobaciones ni duplicar efectos, y las escrituras no eluden rate limits durante la recuperación

#### Scenario: Restore rehearsal
- **WHEN** se restaura un backup en entorno aislado
- **THEN** se verifican relaciones, auditoría y estado de runs, y se documentan tiempos observados sin afirmar un SLA no medido
