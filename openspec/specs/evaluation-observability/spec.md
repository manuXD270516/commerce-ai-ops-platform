# evaluation-observability Specification

## Purpose
Garantizar que el sistema se construye, verifica, evalúa, observa y despliega de forma reproducible, y que ningún objetivo, simulación o dato no medido se presenta como resultado. Cubre el bootstrap de M0, el ciclo de vida spec-driven, los gates de evaluación, trazas y auditoría (M10) y el despliegue resiliente listo para AKS con recuperación ensayada (M11; aplicarlo en Azure es un paso futuro que requiere autorización explícita), y la publicación de esa evidencia como sitio estático (2026-10-02). Excepciones aceptadas de M10 (2026-10-01): la release del holdout falla `intent_routing_macro_f1` (0,936 < 0,95) y `retrieval_mrr_at_5` (0,792 < 0,8) y las etiquetas no tienen adjudicación de dos revisores; ver `openspec/changes/archive/2026-10-01-add-evaluation-gates/design.md` (decisión 9). Ninguna excepción aplica a gates de seguridad.

## Requirements

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
El MVP SHALL tener un entorno local reproducible y una configuración de despliegue en Azure Kubernetes Service lista para aplicar, con TLS, servicios de datos privados, secretos administrados fuera de los manifiestos, health/readiness, migraciones controladas y ensayo de recuperación. Aplicarla en Azure SHALL requerir autorización explícita del dueño del repositorio; ningún paso automático crea recursos cloud.

#### Scenario: Redis restart
- **WHEN** se pierde estado de coordinación de Redis
- **THEN** outbox/runs durables permiten reconstruir trabajo sin perder aprobaciones ni duplicar efectos, y las escrituras no eluden rate limits durante la recuperación

#### Scenario: Restore rehearsal
- **WHEN** se restaura un backup en entorno aislado
- **THEN** se verifican relaciones, auditoría y estado de runs, y se documentan tiempos observados sin afirmar un SLA no medido

#### Scenario: Deployment-ready validation without cloud resources
- **WHEN** se valida la configuración de AKS sin credenciales ni recursos de Azure
- **THEN** la IaC pasa formato y validación, los manifiestos se renderizan y validan contra los esquemas, y desplegados en un cluster Kubernetes local ejecutan la demo con migración que no resetea datos, sin crear ningún recurso cloud

#### Scenario: Secrets never inline
- **WHEN** se inspeccionan los manifiestos, la IaC y el workflow de despliegue
- **THEN** ningún secreto aparece en ellos: en AKS llegan desde Key Vault por el driver CSI con workload identity, y el despliegue usa OIDC federado sin claves guardadas

### Requirement: Public static evidence site
El repositorio SHALL publicar en GitHub Pages un sitio estático generado sólo desde la evidencia archivada, con el estado MEASURED/SIMULATED de cada resultado y las excepciones aceptadas visibles, publicado únicamente después de que CI pase para el mismo commit y sin rutas locales, credenciales, tokens, claves ni PII.

#### Scenario: Publication after green CI
- **WHEN** `ci` termina con éxito en `main`
- **THEN** el workflow de Pages construye el sitio desde ese commit y lo despliega, y si `ci` falla no se publica nada

#### Scenario: Private data in the evidence
- **WHEN** el contenido a publicar contiene una ruta local, una cadena de conexión, un token, una clave privada o un email
- **THEN** el build termina con error y no escribe la página

#### Scenario: Honest labels
- **WHEN** un visitante lee los resultados de evaluación
- **THEN** cada gate muestra su estado MEASURED o SIMULATED, los gates fallidos aparecen como fallidos y las excepciones aceptadas están explicadas
