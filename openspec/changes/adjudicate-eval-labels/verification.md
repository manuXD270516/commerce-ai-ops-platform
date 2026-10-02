# Verification

## Estado

Protocolo y herramientas listos (2026-10-02). La revisión humana no empezó: **espera a un segundo revisor**. No archivar hasta completar las tareas 2.x.

## Evidencia exigida

Acuerdo por campo de dev y holdout, registro de adjudicación, `ops-eval@1.1.0` con holdout nuevo y release repetida.

## Resultados

| Escenario | Evidencia | Estado |
|---|---|---|
| Blind review sheet | `evals/test/adjudication.test.ts` (la hoja no contiene etiquetas del autor); la CLI se niega a sobrescribir; hojas generadas: dev 180, holdout 120 | verificado |
| Agreement report | `evals/test/adjudication.test.ts` (κ de Cohen contra un caso de referencia = 0,5; conjuntos sin orden; desacuerdos y casos incompletos listados); `compare` sobre la hoja vacía reporta 0 etiquetados y 180 faltantes | herramientas verificadas; sin datos humanos todavía |
