# Verification

## Estado

Completo. Evidencias MEASURED contra PostgreSQL 17 + pgvector 0.8.6 de Compose local (Windows 11, Node 22.23.1), el 2026-10-01. Embeddings: `local-hash-v1`, determinístico y local (design.md, decisión 2); ningún modelo de terceros ni descarga de pesos.

## Evidencia exigida

Gate de salida (roadmap): Recall baseline; no fugas; versiones históricas; no candidatos; retiro/invalidation.

Evidencia por capability: Corpus versionado, ACL, elegibilidad SQL, recall contra baseline exacto, citas, retiro e inyección en documentos.

## Resultados

Comandos: `pnpm verify` (lint, formato, typecheck, build, tests contra la BD, contratos y evals) en verde con 115 tests; `pnpm db:seed` ingiere el corpus `knowledge@0.1.0` (14 versiones) y es idempotente; `pnpm openspec:validate` estricto en verde.

| Escenario | Evidencia |
| --- | --- |
| Repeated ingestion | `packages/domain/test/knowledge.test.ts` "does not duplicate documents, versions, chunks or embeddings on repeated ingestion": una reingesta secuencial y dos concurrentes devuelven la misma versión con `duplicate: true` y los conteos de documents/document_versions/chunks no cambian. |
| Retired policy | "retires a version: gone from new retrievals and cache, still resolvable and audited": la segunda consulta sale de cache; tras retirar, la consulta no usa cache y la versión no aparece; `getDocumentVersion` la sigue resolviendo como `retired`; hay un `audit_events` `knowledge.retire`; retirar de nuevo devuelve CONFLICT. "only admins ingest, and drafts are not retrievable until published" cubre la publicación. |
| Semantically relevant but unavailable | "never recommends a semantically relevant SKU that SQL makes ineligible": con NB-DEV-32 sin stock disponible y la ficha de un producto en borrador igual de relevante, sólo NB-DEV-32X es recomendado (`ranking: hybrid`, evidencia de su ficha). |
| No eligible result | "reports no candidates without relaxing budget or attributes": `NO_CANDIDATES` con los mismos filtros (precio < 150000, 64 GB); moneda EUR rechazada con VALIDATION_ERROR. |
| Historical purchase policy | "uses the returns policy in force when the order was placed": orden de agosto → versión 1 (30 días), orden de septiembre → versión 2; otro customer recibe NOT_FOUND. "respects validity, so a past date retrieves the version then in force" cubre la búsqueda por fecha. |
| Missing or conflicting evidence | "abstains when no policy applies or two sources conflict without precedence": `ABSTAIN / NO_APPLICABLE_POLICY` antes de toda vigencia y `ABSTAIN / CONFLICTING_POLICIES` con las dos citas cuando dos fuentes rigen a la vez. |
| Prompt injection in product documentation | "returns injected instructions as untrusted text without granting any effect": el documento que ordena ejecutar update_order vuelve como hit `trust: untrusted_corpus_text`, el resultado sólo trae datos y citas, y la instantánea de órdenes (id, estado, versión) queda igual. |
| ACL y tenant antes del ranking | "filters by ACL and tenant before ranking" y "keeps cache entries apart per role": un procedimiento interno (support/admin) no llega a un customer, tampoco vía cache, y un documento de globex no aparece para acme. |

Reportes de evals (`evals/reports/retrieval-{dev,holdout}-*.md`, MEASURED, dataset `knowledge@0.1.0` con sha256 en el manifiesto). Valores determinísticos entre corridas; sólo la latencia varía.

| Split (n) | Estrategia | Recall@5 | MRR@5 | Fuentes prohibidas | Otro tenant |
| --- | --- | --- | --- | --- | --- |
| dev (14) | hybrid | 0.929 | 0.893 | 0 | 0 |
| dev (14) | vector | 0.929 | 0.774 | 0 | 0 |
| dev (14) | fulltext | 0.786 | 0.786 | 0 | 0 |
| holdout (12) | hybrid | 0.917 | 0.792 | 0 | 0 |
| holdout (12) | vector | 0.917 | 0.764 | 0 | 0 |
| holdout (12) | fulltext | 0.833 | 0.708 | 0 | 0 |

`vector_recall_vs_exact_baseline` = 1 (84/84 posiciones top-6, dev): la búsqueda vectorial SQL coincide con un cálculo coseno exhaustivo en Node sobre el mismo subconjunto autorizado. Latencia p95 por consulta en proceso, con la auditoría incluida, entre 10 y 55 ms en esta máquina; no es una prueba de carga.

## Límites

- Recall@5 no es discriminante con 11 fuentes visibles por tenant; MRR@5 muestra la ventaja de la fusión (dev 0.893 frente a 0.774/0.786). Corpus y etiquetas son sintéticos, de un solo autor y sin adjudicación por un segundo revisor.
- La comparación con modelos neuronales (ONNX) no se ejecutó: requiere descargar pesos y no está autorizada. El embedder seleccionado es léxico.
- GitHub Actions no arranca jobs por facturación de la cuenta; la verificación es local con los mismos comandos que CI.
