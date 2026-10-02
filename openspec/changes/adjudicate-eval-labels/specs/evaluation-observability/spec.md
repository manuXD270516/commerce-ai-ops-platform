## ADDED Requirements

### Requirement: Two-reviewer label adjudication
Las etiquetas de los datasets de release SHALL revisarse a ciegas por una segunda persona, con acuerdo medido por campo (proporción y κ de Cohen) y cada desacuerdo adjudicado y registrado antes de que una release declare sus gates de calidad como cumplidos.

#### Scenario: Blind review sheet
- **WHEN** se genera la hoja de un segundo revisor
- **THEN** contiene sólo las entradas de cada caso y campos vacíos, nunca las etiquetas del autor, y no sobrescribe una hoja existente

#### Scenario: Agreement report
- **WHEN** se comparan las etiquetas del autor con las del revisor
- **THEN** el reporte da acuerdo y κ por campo, excluye y lista los casos incompletos y enumera cada desacuerdo para la adjudicación
