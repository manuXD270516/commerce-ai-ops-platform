## ADDED Requirements

### Requirement: Reproducible bootstrap with correlated smoke
El repositorio SHALL arrancar desde un clone limpio con versiones exactas y lockfile, ejecutar lint, typecheck, build, tests, contratos y evals con los mismos comandos en local y CI, y verificar mediante smoke que web, API, worker y servidor MCP arrancan y que un request web → api conserva un correlation id visible en logs estructurados, sin secretos en el repositorio.

#### Scenario: Clean clone
- **WHEN** se clona el repositorio y se ejecutan los comandos documentados
- **THEN** la instalación con lockfile congelado, lint, typecheck, build, tests, contratos y evals terminan sin errores

#### Scenario: Correlated request
- **WHEN** el smoke envía a web un request con un X-Correlation-Id válido
- **THEN** la respuesta, los logs JSON de web y de API y la traza comparten ese identificador

#### Scenario: Untrusted correlation id
- **WHEN** el header X-Correlation-Id está malformado
- **THEN** se genera un identificador nuevo y el valor recibido no aparece en ningún log

#### Scenario: Evaluation report labels
- **WHEN** el harness ejecuta una suite contra un objetivo simulado
- **THEN** el reporte la etiqueta SIMULATED y la validación rechaza cualquier resultado MEASURED en esa corrida

#### Scenario: No secrets in the repository
- **WHEN** se escanea el historial git
- **THEN** no se detectan secretos y .env.example sólo contiene valores locales no secretos

### Requirement: Spec-driven change lifecycle
Cada feature SHALL seguir proposal → spec → design → tasks → implementation → verification en un change propio por milestone o capacidad; un change sólo se archiva cuando todas sus tareas están marcadas con evidencia real en su verification.md y la validación estricta de OpenSpec pasa.

#### Scenario: Milestone not started
- **WHEN** un milestone no ha comenzado
- **THEN** su change existe con tareas sin marcar y su verification.md declara que no hay implementación, sin presentar objetivos como resultados

#### Scenario: Archiving a change
- **WHEN** se archiva un change
- **THEN** todas sus tareas están marcadas con evidencia en verification.md y `openspec validate --strict` termina sin errores
