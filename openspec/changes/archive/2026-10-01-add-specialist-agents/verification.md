# Verification

## Estado

Completo. Evidencias MEASURED contra código local y PostgreSQL 17 de Compose (Windows 11, Node 22.23.1), el 2026-10-01. Ningún especialista llama a un LLM: la redacción final es `template-synth.v1` (SIMULATED) y no agrega hechos.

## Evidencia exigida

Gate de salida (roadmap): Casos end-to-end con evidencia; guardrails; cero escrituras privilegiadas sin M8.

Evidencia por capability: Casos missing/stale/partial/lost, nDCG y elegibilidad, trazabilidad de explicaciones a reglas.

## Resultados

Comandos: `pnpm verify` en verde con 157 tests; `pnpm openspec:validate` estricto en verde.

| Escenario | Evidencia |
| --- | --- |
| Lost shipment | `packages/ai/test/specialists.test.ts` "lost shipment: evidence and escalation, no invented cause and no ticket without consent": hecho LOST con evidencia `shipment`, escalamiento `escalation.v1/shipment_lost`, incertidumbre "no hay una causa registrada", oferta de ticket condicionada a confirmación y conteo de tickets sin cambios. |
| Stale or unavailable tracking | "partial and stale shipment…": SIM-401-B stale con su timestamp (2026-09-20T12:00Z) y "no puedo confirmar una fecha de entrega". "unavailable tracking degrades to partial without asserting any date": `get_shipping_status` con DEPENDENCY_UNAVAILABLE → hallazgo `partial`, sin hechos de paquete ni fechas. |
| Escalation threshold | Unit "escalates LOST, DELIVERED_DISPUTED and delays over 48 h, nothing else" (48 h no escala, 49 h sí) y "escalates a delay over 48 h and DELIVERED_DISPUTED, but not a 30 h delay" contra la BD. |
| Partial shipment y missing order (tarea 1.1) | "partial and stale shipment…": ambos paquetes con sus líneas, inferencia rotulada "Inferencia: es un envío parcial" y política aplicable citada. "missing or foreign order: not found, with nothing revealed": id inexistente, orden de otro customer y de otro tenant → `not_found` sin hechos. |
| Stock changes during generation | "drops a candidate that loses stock while the answer is being prepared": NB-DEV-32 pierde disponibilidad entre la búsqueda y la revalidación; sólo se recomienda NB-DEV-16 y la incertidumbre lo informa. |
| Elegibilidad, preferencias y nDCG (tarea 1.2) | "keeps budget, currency and attributes strict and uses preferences only to order": todos < USD 1.500 y USD, preferencia de RAM sólo como orden; 64 GB < USD 1.500 → `no_candidates` sin relajar. Suite `evals/reports/recommendation-*.md` (`recommendation@0.1.0`): nDCG@3 = 1.000 (n=8 consultas con candidatos), `recommendation_eligible_ratio` = 15/15 con predicado SQL independiente, abstención correcta 2/2. |
| Inventory sin autoridad (tarea 1.3) | "explains alerts from the rule id, version and recorded evidence without changing stock": la explicación de `discrepancy` cita `anomaly.v1`, conteo 1 del 2026-09-29 y on_hand 4 tal como los registró el detector; sólo se llamaron tools READ; balances idénticos antes y después; un customer recibe `forbidden`. El router rechaza "ajusta el stock" (M6). |
| Cero escrituras privilegiadas sin M8 | Los especialistas sólo proponen; `update_order` únicamente corre desde `execute_action` tras una aprobación leída de la BD (M6 graph tests), y la tool exige aprobación en dominio (M5). |

## Límites

- Catálogo de demo de cinco SKUs publicados: nDCG@3 = 1 no es evidencia de calidad general; las etiquetas son de un solo autor que conoce la lógica de ranking.
- La redacción es por plantilla (SIMULATED); no se midió un modelo real.
- GitHub Actions no arranca jobs por facturación de la cuenta; verificación local con los mismos comandos que CI.
