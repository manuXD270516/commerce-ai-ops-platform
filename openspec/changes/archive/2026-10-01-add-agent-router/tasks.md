## 1. M6 — Agent router
- [x] 1.1 Comparar proveedores/modelos con dataset de desarrollo y registrar selección/versiones (evaluation-observability). Candidatos locales (reglas, Naive Bayes, combinación) bajo la restricción sin claves de IA; proveedores comerciales no comparados (design.md, decisión 1).
- [x] 1.2 Implementar router determinístico + clasificador estructurado y aclaraciones; medir macro-F1 (agent-workflows).
- [x] 1.3 Implementar LangGraph/checkpoints, budgets, cancelación y reanudación autorizada; probar reinicio (agent-workflows).

## 2. Verification y cierre
- [x] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [x] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
