## ADDED Requirements

### Requirement: Structured catalog and money
El sistema SHALL representar SKUs con atributos tipados, importes enteros y moneda; aplicar filtros explícitos antes de recomendar.

#### Scenario: Strict budget
- **WHEN** se consulta una notebook por menos de USD 1.500
- **THEN** sólo son elegibles SKUs publicados con currency USD y price_minor <150000
