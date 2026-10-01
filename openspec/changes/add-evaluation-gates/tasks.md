## 1. M10 — Evals
- [ ] 1.1 Completar 300 casos adjudicados y holdout sellado, baselines y tres repeticiones; registrar métricas y denominadores (evaluation-observability).
  - Hecho: 300 casos (`ops-eval@1.0.0`), holdout sellado por procedimiento, baselines y tres repeticiones con denominadores. **Pendiente:** adjudicación por dos revisores humanos; requiere personas.
- [x] 1.2 Ejecutar gates de seguridad, calidad, performance y tokens; verificar cero accesos/efectos indebidos y reportar intervalos (evaluation-observability).
  - Ejecutados (`pnpm evals:release`, `pnpm load`): seguridad 0/0, intervalos de Wilson; la release **falla** routing macro-F1 (0,936) y MRR@5 (0,792). Ver verification.md.
- [x] 1.3 Completar dashboards/trazas y auditar redacción/retención de PII (evaluation-observability).

## 2. Verification y cierre
- [x] 2.1 Vincular cada escenario de este change a tests/reportes y registrar resultados reales en verification.md.
- [ ] 2.2 Validar OpenSpec en modo estricto, revisar diferencias contra el contrato y sólo entonces archivar.
  - No archivado mientras 1.1 siga abierta.
