## 1. Protocolo y herramientas
- [x] 1.1 Protocolo de revisión ciega, acuerdo y adjudicación (design.md) (evaluation-observability).
- [x] 1.2 Herramientas `adjudication sheet|compare` con tests, y hojas ciegas de dev y holdout para `reviewer-2` (evaluation-observability).

## 2. Revisión humana (requiere una segunda persona)
- [ ] 2.1 Un segundo revisor completa `evals/adjudication/ops-eval-1.0.0/dev.reviewer-2.jsonl` y `holdout.reviewer-2.jsonl` siguiendo la guía.
- [ ] 2.2 Ejecutar `adjudication compare` para ambos splits y registrar acuerdo y κ por campo.
- [ ] 2.3 Adjudicar cada desacuerdo (con un tercero si no hay consenso) y publicar `ops-eval@1.1.0` con un holdout nuevo sellado.
- [ ] 2.4 Repetir `pnpm evals:release` sobre 1.1.0 y actualizar las excepciones aceptadas de M10.

## 3. Verification y cierre
- [ ] 3.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [ ] 3.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
