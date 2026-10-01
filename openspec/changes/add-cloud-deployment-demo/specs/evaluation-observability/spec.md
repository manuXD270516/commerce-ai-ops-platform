## ADDED Requirements

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
