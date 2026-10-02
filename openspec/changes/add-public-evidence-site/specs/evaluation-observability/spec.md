## ADDED Requirements

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
