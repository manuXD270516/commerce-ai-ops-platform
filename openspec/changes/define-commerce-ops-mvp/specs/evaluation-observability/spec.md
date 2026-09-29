## ADDED Requirements

### Requirement: Versioned evaluation gates
El proyecto SHALL medir las diez dimensiones solicitadas con dataset versionado, baseline, holdout y gates de docs/rag-evals.md; resultados incluirán denominadores y configuración reproducible.

#### Scenario: Unauthorized effect in release evaluation
- **WHEN** ocurre una lectura indebida o efecto no autorizado durante las pruebas
- **THEN** la release falla aunque los promedios restantes superen sus umbrales

#### Scenario: Simulated provider benchmark
- **WHEN** una corrida usa un proveedor simulado
- **THEN** el reporte la identifica como SIMULATED y no la presenta como latencia/calidad de un proveedor real

### Requirement: Correlated traces and protected audit
El sistema SHALL correlacionar request/run/tool/action, métricas de tokens/latencia y decisiones auditadas sin registrar secretos, PII innecesaria ni chain-of-thought.

#### Scenario: Investigate an executed action
- **WHEN** un revisor autorizado consulta una acción
- **THEN** identifica actor, aprobación, política, versión, resultado e idempotencia mediante evidencia persistida

### Requirement: Resilient deployment and recovery
El MVP SHALL tener un entorno local reproducible y demo cloud con TLS, servicios de datos privados, secretos administrados, health/readiness, migraciones controladas y ensayo de recuperación.

#### Scenario: Redis restart
- **WHEN** se pierde estado de coordinación de Redis
- **THEN** outbox/runs durables permiten reconstruir trabajo sin perder aprobaciones ni duplicar efectos, y las escrituras no eluden rate limits durante la recuperación

#### Scenario: Restore rehearsal
- **WHEN** se restaura un backup en entorno aislado
- **THEN** se verifican relaciones, auditoría y estado de runs, y se documentan tiempos observados sin afirmar un SLA no medido

### Requirement: Spec-driven change lifecycle
Cada feature SHALL seguir proposal → spec → design → tasks → implementation → verification; el change inicial permanecerá sin implementar hasta una instrucción posterior.

#### Scenario: Documentation-only delivery
- **WHEN** termina esta primera tarea
- **THEN** existen artefactos revisables, tareas sin marcar y reporte de validación documental, sin aplicaciones ni infraestructura provisionadas
