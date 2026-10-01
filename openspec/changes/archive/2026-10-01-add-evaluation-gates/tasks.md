## 1. M10 — Evals
- [x] 1.1 Completar 300 casos y holdout sellado, baselines y tres repeticiones; registrar métricas y denominadores (evaluation-observability).
  - 300 casos (`ops-eval@1.0.0`), holdout sellado por procedimiento, baselines y tres repeticiones con denominadores. **Excepción aceptada (2026-10-01):** la adjudicación por dos revisores humanos no se hizo y queda como punto abierto (design.md, decisión 9).
- [x] 1.2 Ejecutar gates de seguridad, calidad, performance y tokens; verificar cero accesos/efectos indebidos y reportar intervalos (evaluation-observability).
  - Ejecutados (`pnpm evals:release`, `pnpm load`): seguridad 0/0, intervalos de Wilson; la release falla routing macro-F1 (0,936) y MRR@5 (0,792), aceptados como excepción por el dueño del repo (design.md, decisión 9).
- [x] 1.3 Completar dashboards/trazas y auditar redacción/retención de PII (evaluation-observability).

## 2. Verification y cierre
- [x] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [x] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
  - Validado en modo estricto; archivado con las excepciones aceptadas documentadas.
