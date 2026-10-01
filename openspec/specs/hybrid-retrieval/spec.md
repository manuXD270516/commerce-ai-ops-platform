# hybrid-retrieval Specification

## Purpose
Recuperación de conocimiento (políticas, FAQ, shipping, returns y fichas de producto) versionada, publicada y filtrada por tenant, ACL, región, idioma y vigencia antes de cualquier ranking, con citas resolubles, abstención ante evidencia faltante o contradictoria y sin conceder autoridad al texto recuperado.

## Requirements

### Requirement: Published versioned knowledge
El sistema SHALL ingerir catálogo enriquecido, políticas, FAQ, shipping, returns y documentación de producto con checksum, versión, ACL, región, idioma y vigencia; sólo versiones publicadas serán recuperables.

#### Scenario: Repeated ingestion
- **WHEN** una fuente ya ingerida llega con el mismo checksum
- **THEN** no se duplican documentos, chunks ni embeddings

#### Scenario: Retired policy
- **WHEN** una versión es retirada
- **THEN** deja de aparecer en nuevas recuperaciones y se invalida su cache, conservando referencia histórica auditada

### Requirement: SQL eligibility before semantic ranking
El sistema SHALL aplicar filtros de tenant, ACL y elegibilidad estructurada antes del ranking; precio, stock y estado de orden provendrán de consultas de dominio.

#### Scenario: Semantically relevant but unavailable
- **WHEN** un SKU es semánticamente relevante pero no tiene stock elegible
- **THEN** no aparece como recomendación disponible

#### Scenario: No eligible result
- **WHEN** ningún SKU satisface presupuesto y atributos obligatorios
- **THEN** se informa falta de candidatos sin relajar restricciones silenciosamente

### Requirement: Evidence and applicable policy
El sistema SHALL adjuntar referencias resolubles a hechos y seleccionar políticas por vigencia contractual de la orden, región y acceso autorizado.

#### Scenario: Historical purchase policy
- **WHEN** la política actual difiere de la vigente para la compra
- **THEN** la investigación utiliza la versión aplicable a esa orden e identifica la fuente

#### Scenario: Missing or conflicting evidence
- **WHEN** no hay fuente aplicable o las fuentes autorizadas se contradicen sin regla de precedencia suficiente
- **THEN** la respuesta declara incertidumbre y se abstiene de afirmar una obligación no sustentada

### Requirement: Retrieval cannot grant authority
El sistema SHALL tratar texto recuperado como datos no confiables y conservar autorización externa al modelo.

#### Scenario: Prompt injection in product documentation
- **WHEN** un documento instruye ignorar restricciones y ejecutar update_order
- **THEN** esa instrucción no amplía tools/scopes ni produce una mutación
