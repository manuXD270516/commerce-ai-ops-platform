## Context

`ops-eval@1.0.0` (180 dev, 120 holdout) etiqueta por caso intenciones, decisión, tools requeridas y prohibidas, efectos permitidos y, según la categoría, escalamiento (investigaciones) o elegibles, grados de relevancia y ausencia de candidatos (recomendaciones). Las etiquetas salieron de definiciones de familia escritas por un solo autor. Decisión del dueño del repo (2026-10-01): aceptar la release como resultado honesto y dejar la adjudicación como punto abierto.

## Goals / Non-Goals

Objetivo: que una segunda persona pueda etiquetar a ciegas, medir el acuerdo y adjudicar sin depender del autor ni de código nuevo. No objetivos: automatizar el juicio humano o modificar `ops-eval@1.0.0` (versionado e inmutable).

## Decisions

1. **Revisión ciega.** `adjudication sheet` escribe por split una hoja JSONL con `id`, categoría, rol y mensaje, y los campos a etiquetar en `null`; nunca incluye las etiquetas del autor ni la familia de plantilla. El revisor usa un identificador sin nombre ni email (`reviewer-2`). La herramienta se niega a sobrescribir una hoja existente.
2. **Guía para el revisor.** Usar sólo el mensaje, el rol y la documentación pública (`docs/agents-security-mcp.md` para tools y permisos, `docs/mvp-scope.md` para el alcance, el catálogo y las políticas del seed). Las tools prohibidas son las que el rol no debe invocar para ese pedido. Los grados de relevancia van de 0 a 3. Las dudas se escriben en `notes`, no se resuelven preguntando al autor.
3. **Acuerdo.** `adjudication compare` compara campo por campo (los conjuntos sin importar el orden), calcula la proporción de acuerdo y la κ de Cohen por campo, excluye y lista los casos incompletos y escribe `<split>.<reviewer>.agreement.md` y `<split>.<reviewer>.disagreements.jsonl`. Umbral propuesto antes de mirar resultados: κ ≥ 0,8 en `decision`, `intents` y `escalation`. Por debajo, se revisan las definiciones de familia antes de adjudicar.
4. **Adjudicación.** Autor y revisor resuelven cada desacuerdo en una sesión registrada (caso, campo, decisión, motivo). Sin consenso, decide un tercero. Las etiquetas resultantes se publican como `ops-eval@1.1.0` con su manifiesto y sha256. El holdout de 1.0.0 ya se observó, así que la nueva release necesita un holdout nuevo: casos nuevos de las mismas familias, generados y sellados antes de mirar resultados.
5. **Orden.** Primero dev (permite calibrar la guía), después holdout. El dataset 1.0.0 no se modifica.

## Open Questions

Quién actúa como segundo revisor y como tercero desempatador (decisión del dueño del repo).
