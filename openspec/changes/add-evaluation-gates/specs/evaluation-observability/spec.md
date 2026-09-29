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
