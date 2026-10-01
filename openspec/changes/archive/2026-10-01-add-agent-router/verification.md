# Verification

## Estado

Completo con la restricción del proyecto: sin modelos comerciales. Evidencias MEASURED contra código local y PostgreSQL 17/Redis de Compose (Windows 11, Node 22.23.1), el 2026-10-01. La síntesis `template-synth.v1` es determinística y SIMULATED; ninguna cifra describe un proveedor LLM real.

## Evidencia exigida

Gate de salida (roadmap): Macro-F1 y errores; reanudación durable; supervisor sin reglas de negocio.

Evidencia por capability: Macro-F1 y matriz de confusión con denominadores, reinicio del worker sin duplicar efectos y presupuestos agotados con evidencia parcial.

## Resultados

Comandos: `pnpm verify` en verde con 147 tests; `pnpm smoke` 17/17 (incluye un run API → BullMQ → worker → checkpoints que termina COMPLETED/ANSWERED); `pnpm openspec:validate` estricto en verde.

Routing (`evals/reports/router-{dev,holdout}-*.md`, dataset `router@0.1.0`, multi-label macro-F1 sobre cuatro intenciones, denominador = casos del split):

| Estrategia | dev macro-F1 (n=23) | dev decisión | holdout macro-F1 (n=23) | holdout exact-set | holdout decisión |
| --- | --- | --- | --- | --- | --- |
| rules | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| classifier (Naive Bayes local) | 0.650 | 0.739 | 0.571 | 0.565 | 0.652 |
| rules+classifier (seleccionada) | 1.000 | 1.000 | 0.918 | 0.913 | 0.913 |

Errores de la estrategia seleccionada en holdout: `oos-weather-01` ("¿Va a llover mañana?") pidió aclaración en vez de rechazar, y `oos-weather-02` ("Recomiéndame una película") se enrutó a recomendación de productos; en ambos casos ninguna regla aplicó y decidió el clasificador. Matriz de confusión y F1 por clase en el reporte (out_of_scope F1 0.75, soporte 5). La selección se fijó en dev antes del holdout y no se ajustó después; la meta EXPECTED de macro-F1 ≥ 0.95 (rag-evals.md) no se cumple en holdout con esta configuración y queda para M10. `router_model_drift` = 0: el clasificador versionado coincide con un reentrenamiento sobre el mismo train.

| Escenario | Evidencia |
| --- | --- |
| Ambiguous order intent | `packages/ai/test/ai.test.ts` "routes with rules first and asks for missing or ambiguous order ids" y `packages/ai/test/graph.test.ts` "asks for clarification or refuses without calling any tool": sin id o con dos ids el run termina `CLARIFICATION_REQUESTED` con 0 llamadas a tools auditadas para ese run. |
| Worker restart while awaiting approval | graph.test "survives a worker restart while waiting for approval and executes the effect once": el run queda WAITING_HUMAN; un executor nuevo con otro pool (proceso simulado) lo retoma desde PostgreSQL y sigue esperando sin tocar la orden (CONFIRMED v1); con solicitud confirmada pero pendiente tampoco ejecuta; tras la aprobación ejecuta una vez (CANCELLATION_REQUESTED v2), una sola fila en `action_executions`, y una entrega duplicada posterior es SKIPPED. "does not execute after the requester loses access during the human wait": membership revocada → `FAILED/ACCESS_REVOKED` y la orden no cambia. "lets a second worker take over only after the first lease expires". `apps/worker/test/agent-run-job.test.ts`: un run sin job (pérdida de Redis) se completa con el barrido de recuperación. |
| Budget exhausted | graph.test "ends with labelled partial evidence and no further tool calls when the budget runs out": con `toolCalls: 1`, exactamente una llamada auditada, outcome `BUDGET_EXCEEDED`, `partial: true` y la dimensión agotada en el resumen. `ai.test.ts` "run budgets" prueba que la llamada que pasaría el límite se rechaza y que el tiempo de espera no cuenta. |
| Supervisor sin reglas de negocio | El grafo sólo enruta y delega: precios, stock, elegibilidad y escalamiento salen de tools y del dominio (`assessEscalation`, `executeUpdateOrder`). Pedidos de cambiar precio o aprobar → REFUSED sin tools (graph.test). |
| Cancelación y aislamiento | graph.test "cancels a queued run so no worker starts it, and hides runs from other customers" y `apps/api/test/runs.test.ts` (202 + contrato `agent-run.schema.json`, SSE con `Last-Event-ID` que reenvía sólo eventos perdidos sin crear otro run, 404 a otro customer, 409 al cancelar un run terminado). |

## Límites

- Proveedores LLM comerciales no comparados (sin claves ni presupuesto autorizado); el clasificador y el sintetizador son locales y, en el caso del sintetizador, SIMULATED.
- Dataset de 76 casos sintéticos de un solo autor; sin adjudicación por segundo revisor.
- GitHub Actions no arranca jobs por facturación de la cuenta; verificación local con los mismos comandos que CI.
