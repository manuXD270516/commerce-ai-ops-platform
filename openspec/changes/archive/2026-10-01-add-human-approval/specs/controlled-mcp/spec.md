## ADDED Requirements

### Requirement: Bound human approval
El sistema SHALL vincular la aprobación privilegiada a sujeto, tenant, recurso, tool, argumentos canónicos, expected_version, policy_version y TTL; el aprobador será autorizado y distinto del solicitante.

#### Scenario: Agent attempts self-approval
- **WHEN** el modelo declara que la acción está aprobada o el solicitante intenta aprobarla
- **THEN** no se genera una aprobación válida ni se ejecuta el efecto

#### Scenario: Changed payload or expired approval
- **WHEN** cambia el payload/versión, la aprobación vence o es rechazada
- **THEN** la ejecución produce cero cambios de dominio y exige una nueva solicitud cuando corresponda

### Requirement: Atomic single effect
El sistema SHALL consumir aprobación, mutar dominio, auditar y registrar idempotencia en una transacción; la entrega al menos una vez no duplicará efectos.

#### Scenario: Response lost after commit
- **WHEN** un worker reintenta después de perder la respuesta de un commit exitoso
- **THEN** recupera el resultado existente sin segunda transición ni segundo consumo

#### Scenario: Replay with a new key
- **WHEN** se intenta reutilizar una aprobación consumida con otra clave
- **THEN** se rechaza sin efecto adicional

### Requirement: Verified identity on every entry point
El sistema SHALL verificar identidad, audiencia, vigencia y scopes y revalidar membership al reanudar; no aceptará tokens de otra audiencia ni autorización fabricada por el modelo.

#### Scenario: Revoked access during human wait
- **WHEN** el acceso del solicitante se revoca mientras el run espera aprobación
- **THEN** la reanudación no ejecuta el comando aunque exista una aprobación anterior
