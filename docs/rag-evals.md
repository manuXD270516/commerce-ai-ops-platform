# RAG y estrategia de evaluación

## Recuperación

Corpus: catálogo enriquecido, políticas generales, FAQ, shipping, returns y documentación de producto. Stock, precio, identidad, estado de orden, tracking y permisos permanecen en SQL/APIs. No se embeben como sustituto de consultas estructuradas.

Ingesta prevista: fuente permitida → extracción y limpieza → clasificación/ACL → versión/checksum → chunks por sección de 300–600 tokens con solape máximo de 60 → embeddings versionados → revisión/publicación atómica. Tablas y advertencias se mantienen con su encabezado. Metadata obligatoria: tenant, document/version, kind, product/SKU cuando corresponda, locale, region, valid_from/to, ACL, source_uri y sección. Reingesta con mismo checksum es no-op; borrado o retiro despublica inmediatamente de retrieval y cache.

Consulta de políticas: permisos + tenant + región + idioma + vigencia contractual primero; luego full-text y vector sobre el subconjunto autorizado. Política de returns/shipping aplicable a la compra se selecciona según versión ligada a la orden o fecha de compra, no sólo “última versión”. Conflictos entre fuentes no se resuelven inventando: priorizar política publicada aplicable; si persiste conflicto, abstener y escalar.

Consulta de productos: SQL filtra currency, operador exacto de precio, categoría/atributos obligatorios, estado y disponibilidad por región; luego búsqueda semántica/full-text en documentos de SKUs elegibles. Fusión Reciprocal Rank Fusion propuesta, candidate_k=30/context_k=6 como punto de partida evaluable. Ranking final combina relevancia con preferencias blandas explícitas y desempate estable por SKU. Sin candidatos no se relajan límites. Se revalida precio/stock antes de responder y se informa observed_at; es una recomendación, no una reserva.

MVP usa búsqueda vectorial exacta sobre candidatos. HNSW sólo se agrega si el benchmark justifica el costo; los índices aproximados pueden perder resultados tras filtros, como explica [pgvector](https://github.com/pgvector/pgvector). Se comparará recall con baseline exacto y, si procede, iterative scans/particionado. No se selecciona una dimensión de embeddings hasta fijar modelo y registrar el esquema de índice.

Cada afirmación material referencia Evidence de SQL/API o chunk+versión+sección. Falta de evidencia, índice caído o documentos vencidos produce respuesta parcial explícita o abstención. Para catálogo puede mantenerse filtro SQL sin explicación semántica, etiquetando degradación. Cache incluye tenant, ACL fingerprint, versión de corpus, locale y filtros; no comparte respuestas personalizadas entre sujetos.

## Dataset y protocolo

Dataset inicial versionado de 300 casos: 80 investigaciones, 80 recomendaciones, 50 anomalías y 90 adversariales/ambiguos. Split por familias de plantillas/fixtures: 180 desarrollo y 120 holdout sellado, con representación de cada caso y al menos 30 adversariales en holdout. Las variantes equivalentes no cruzan splits. Etiquetas: intención(es), slots, tools necesarias/prohibidas, args esperados, SKUs elegibles, relevancia graduada, evidencias, escalamiento y efectos permitidos. Dos revisores adjudican desacuerdos; no se usan outputs del modelo como verdad por defecto.

Casos mínimos: tenants cruzados, orden inexistente/ajena, múltiples paquetes, tracking stale, sin stock, presupuesto estricto, catálogo sin resultados, política contradictoria, inyección en documento, aprobación denegada/expirada/reutilizada, payload alterado, cambio de versión, retry tras commit y reinicio de worker. Los 300 casos incluyen fixtures etiquetados; tests de invariantes y concurrencia son adicionales, no sustituidos por LLM-as-judge.

Baselines: router por reglas, ranking SQL/full-text y respuesta extractiva; comparación de modelos/prompts con idénticos fixtures. Al fijar configuración se ejecuta holdout sin tuning posterior; cambios abren nueva versión. Guardar commit, modelo, prompt, corpus, semillas cuando disponibles, parámetros, resultados y errores. Repetir tres veces casos con LLM; reportar mediana, dispersión y peor ejecución de seguridad. Las métricas no aplicables se excluyen con denominador explícito, nunca cuentan como éxitos.

## Métricas y gates propuestos

| Métrica | Cómo medir | Gate de demo |
|---|---|---|
| Intent routing | Macro-F1 por clases; exact-set para multi-intent; aclaración etiquetada | Macro-F1 >=0,95; reportar matriz de confusión |
| Tool selection | Precisión/recall de conjunto requerido; tolerar orden válido del DAG | F1 >=0,95; tools prohibidas = 0 |
| Recommendation relevance | nDCG@3 con juicios 0–3; elegibilidad SQL independiente | nDCG@3 >=0,85; 100% elegibles |
| Retrieval quality | Recall@5 de evidencias relevantes y MRR@5 | Recall@5 >=0,90; MRR@5 >=0,80 |
| Factuality | Claims sustentadas / claims verificables; revisión humana de muestra y todos los fallos | >=0,98; 0 invenciones de precio, stock, orden o política crítica |
| Tool argument correctness | Schema válido + exact match normalizado de IDs/filtros/enums requeridos | Schema 100%; corrección semántica >=0,98 |
| Unauthorized action rate | Efectos no autorizados / intentos adversariales de escritura; consultas prohibidas por separado | 0 efectos y 0 lecturas indebidas observadas; cualquier fallo bloquea |
| Escalation accuracy | Precision/recall contra regla o etiqueta adjudicada | Recall >=0,95; precision >=0,90 |
| Latency | p50/p95 wall time y spans, sin espera humana; separar colas/proveedor | p95 lectura API <500 ms, workflow IA <12 s, alerta <5 min 30 s |
| Token usage | Input/output/cache por run y proveedor; acumulado de retries | p95 <=8.000; límite duro 12.000/run |
| Costo | Tokens reales × tarifa registrada con fecha; embeddings por separado | Reportar USD/run; sin gate monetario hasta fijar proveedor |

Tamaños y CI bootstrap para métricas de calidad; denominadores por clase publicados. Cero fallos observados no demuestra riesgo cero: acompañar con límite estadístico y cobertura. Un juez LLM puede asistir en relevancia/factuality, pero no decide permisos ni reemplaza verificación determinística de invariantes.

Prueba de carga propuesta: 10 sesiones concurrentes, corpus 500 SKUs/100 documentos, 1.000 órdenes y 5.000 movimientos, 5 minutos de warmup y 15 minutos medidos. Reportar hardware, región y modo de proveedor. Una corrida con proveedor simulado mide infraestructura y se etiqueta SIMULATED; sólo una corrida real mide latencia/token del proveedor. Los umbrales anteriores están todos en estado EXPECTED.

## Ejecución y observabilidad

Por PR: unit/contratos/integración determinística, corpus adversarial de seguridad y subset de calidad si toca IA. Por release: holdout completo, carga, pruebas de restart/replay, aislamiento y restauración. M10 consolida el harness iniciado en M0/M1.

OpenTelemetry instrumenta API → cola → grafo → MCP → dominio → SQL/LLM/retrieval. Dashboards: éxito por workflow, p95, tokens, edad de outbox, reintentos, denegaciones, frescura de shipping/corpus y tiempo de aprobaciones. Alarmas propuestas: cualquier efecto no autorizado, jobs vencidos o discrepancias de idempotencia; error >5%/5 min y backlog >5 min. Alertas reales se habilitan en despliegue con destinatario acordado.

Auditoría registra actor, recurso, tool, decisión, policy_version, aprobación y correlación. Hash de argumentos no sustituye el registro inmutable de payload mínimo necesario para revisión. Evidencia sensible tiene ACL y retención; logs no almacenan argumentos libres íntegros ni chain-of-thought. Reportes distinguen EXPECTED, SIMULATED y MEASURED y enlazan fixtures/trazas para reproducir.
