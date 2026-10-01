## Why

La liberación exige medir las diez dimensiones con dataset versionado, holdout y gates, y demostrar trazas y auditoría sin PII innecesaria.

## What Changes

- Dataset de 300 casos con holdout sellado, baselines y tres repeticiones. La adjudicación humana de etiquetas por dos revisores queda como excepción aceptada y punto abierto (decisión del dueño del repo, 2026-10-01; ver design.md, decisión 9).
- Gates de seguridad, calidad, performance y tokens con intervalos.
- Dashboards, trazas y auditoría de redacción y retención de PII.

Fuera de alcance: Nuevas capacidades funcionales; M10 integra evidencia, no inaugura la calidad.

## Capabilities

### New Capabilities

- `evaluation-observability`: 2 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M10 (Evals) del [roadmap](../../../docs/roadmap.md); depende de harness de M0; M4–M9. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 11.1–11.3, renumeradas como 1.x).
