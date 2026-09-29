# Agentes, MCP y seguridad

## Boundaries

| Componente | Puede hacer | No puede hacer |
|---|---|---|
| Supervisor | Seleccionar workflow permitido, solicitar aclaración y ensamblar resultado con evidencia | Ejecutar SQL, calcular stock/SLA, aprobar o inventar permisos |
| Catalog specialist | Interpretar atributos y explicar fichas usando search_products/get_product | Cambiar precios, publicar productos o afirmar disponibilidad por embeddings |
| Order specialist | get_order + get_shipping_status; interpretar timeline y políticas | Afirmar causa no comprobada, modificar orden directamente |
| Inventory specialist | Explicar alertas de reglas y check_inventory | Calcular anomalías mediante intuición LLM, ajustar o reservar stock |
| Support specialist | Consultar políticas vía Knowledge, proponer ticket o cancelación; invocar comando autorizado | Aprobar su propuesta, conceder compensaciones o reembolsos |
| Recommendation specialist | Componer filtros, búsqueda y ranking de productos elegibles | Relajar presupuesto/stock/moneda silenciosamente |

Los especialistas son nodos y perfiles de herramientas, no servicios autónomos. Order y Recommendation lideran sus workflows; Catalog y Support son pasos auxiliares. Inventory usa primero un job SQL determinístico y llama al modelo sólo para explicación bajo demanda. Knowledge es un servicio de recuperación autorizado, sin tool adicional de escritura ni SQL libre.

Routing: el contexto explícito de UI y reglas inequívocas resuelven primero; el clasificador estructurado devuelve una intención permitida, ambigüedad y slots faltantes. El umbral se calibra en evals; no se trata la confianza verbal del modelo como probabilidad. Solicitudes ambiguas aclaran, intentos fuera de alcance responden con limitación, múltiples intenciones se descomponen sin ampliar scopes.

Presupuestos iniciales por run: 6 llamadas LLM, 12 tools, máximo 2 reintentos transitorios de lectura, 60 s de trabajo activo y 12.000 tokens totales. La espera humana queda fuera del tiempo activo. La cancelación del run impide nuevos efectos; una acción ya confirmada se reporta y no se revierte automáticamente. Presupuesto excedido devuelve evidencia parcial etiquetada y opción de escalar.

## Workflows prioritarios

**Order investigation.** Resolver identidad; pedir número de orden si falta o selección si hay varias, sin adivinar. get_order devuelve líneas, fulfillment y versión. get_shipping_status devuelve todos los paquetes y timestamps. El backend calcula atraso contra fecha prometida y marca estado logístico stale después de 6 h (fixture). Retrieval obtiene políticas vigentes por región y fecha aplicable a la orden. La salida distingue hechos, incertidumbre y recomendación. LOST, DELIVERED_DISPUTED o atraso >48 h activan escalamiento determinístico; timeout/stale impide asegurar entrega y ofrece soporte. Crear ticket requiere intención explícita; investigar por sí solo no autoriza una escritura.

**Product recommendation.** Extraer uso, moneda y límites; “menos de USD 1.500” significa `price_minor < 150000`, “hasta” significa `<=`. Filtrar producto publicado, moneda, región, atributos obligatorios y stock; buscar semánticamente en esos candidatos; ordenar y explicar hasta tres opciones con precio/stock revalidados. “Desarrollo” puede dar preferencia a RAM/CPU, pero no agrega requisitos duros no expresados. Cero candidatos produce explicación y pregunta sobre flexibilización, nunca un producto inelegible. Preferencias de cliente sólo con permiso y minimización.

**Inventory anomaly.** Job cada 5 minutos y eventos de stock/órdenes activan reglas versionadas: critical si available <= safety_stock; discrepancy si último conteo válido difiere del balance; unusual_order si cantidad por SKU de una orden supera max(10, 3×mediana histórica) con >=20 observaciones; stockout_risk si available / demanda diaria media de últimos 7 días < lead_time_days. Sin historia suficiente se etiqueta INSUFFICIENT_DATA; demanda cero no divide por cero. Fixtures iniciales: safety_stock=5, lead_time_days=7. Ventanas y parámetros son configurables por tenant. Se deduplican alertas; ningún hallazgo modifica inventario ni abre tickets automáticamente en MVP.

## Contrato MCP

Servidor `commerce-mcp-server`, transporte Streamable HTTP autenticado para entorno cloud. Subject y tenant provienen del token/sesión verificable, nunca de campos confiados al modelo. Schemas JSON estrictos, additionalProperties=false, límites de tamaño, enums y validación semántica. Las respuestas incluyen data/evidence, observed_at, version y errores estables. get_customer omite dirección, email completo y otros datos innecesarios.

| Tool | Clase | Argumentos permitidos principales | Scope y acceso | Guardrails / aprobación |
|---|---|---|---|---|
| search_products | READ | query?, category?, currency, price_lt_minor?/price_lte_minor?, typed_attributes?, in_stock?, cursor?, limit<=50 | catalog:read, tenant activo | SQL parametrizado y ACL; ningún filtro tenant arbitrario |
| get_product | READ | product_id o sku_id, exactamente uno | catalog:read | Producto visible y mismo tenant |
| check_inventory | READ | sku_ids (1–50), region? | inventory:read | Customer ve disponibilidad, inventory ve balances autorizados |
| get_order | READ | order_id | orders:read | Customer sólo own; support/approver por tenant; incluye fulfillment |
| get_customer | READ | customer_id | customers:read:self o customers:read:support | Campos por rol, finalidad de run registrada |
| get_shipping_status | READ | order_id, shipment_id? | shipping:read | Ownership de orden y pertenencia de shipment; fecha/frescura |
| create_support_ticket | WRITE | order_id?, category, summary, evidence_refs?, idempotency_key | tickets:create | Confirmación explícita verificable, schemas, rate limit, dedup; aprobación adicional para contenido marcado sensible |
| update_order | PRIVILEGED | order_id, action=request_cancellation, reason_code, expected_version, action_request_id, idempotency_key | orders:request-cancellation + aprobación válida | Humano approver distinto del requester; revalidación al commit |

WRITE significa efecto reversible acotado; PRIVILEGED significa cambio de estado comercial. Las clasificaciones son política de la aplicación. Las annotations MCP describen hints, **no autorizan**; así lo distingue la [documentación de MCP sobre annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

Customer y support pueden abrir tickets propios/autorizados y solicitar cancelación; inventory sólo consulta catálogo/inventario/alertas; approver revisa solicitudes del tenant; admin gestiona configuración y memberships, sin aprobación implícita. Todos los scopes son intersección de usuario, cliente MCP y especialista. Un service account worker no hereda acceso general: los runs conservan sujeto/tenant y revalidan membresía al reanudarse; jobs de anomalías usan identidad de servicio explícita sin tools de órdenes.

## Aprobación y prevención de replay

1. El usuario confirma intención mediante evento de UI autenticado asociado al run; texto del modelo no prueba consentimiento.
2. El servidor crea ActionRequest inmutable con tool, recurso, argumentos canónicos, hash, sujeto, tenant, versión, policy_version y TTL de 15 minutos.
3. La UI muestra efecto exacto y evidencia; el approver autorizado decide por endpoint protegido. No hay tool `approve` disponible al agente. Denegación o expiración produce cero efectos.
4. update_order comprueba scope actual, ownership, identidad de aprobador, separación de funciones, estado/TTL y hash. El ID es referencia, no credencial bearer.
5. En una transacción se bloquean solicitud/orden, se verifica versión y elegibilidad y se registra efecto+consumo+auditoría+outbox. Orden cambiada invalida solicitud; no se reaprueba automáticamente.
6. Retry tras pérdida de respuesta devuelve resultado previo por idempotencia. Un replay con otra clave se rechaza por solicitud consumida. Reanudación tras reinicio no duplica ticket ni transición.

create_support_ticket normal usa consentimiento explícito y control determinístico sin segundo operador; si el contenido contiene PII no necesaria se redacta o bloquea y se solicita revisión. Un ticket creado no implica email enviado: notificaciones externas quedan fuera.

## Threat model y controles

| Amenaza / frontera | Control y evidencia requerida |
|---|---|
| BOLA/IDOR entre cliente y API, o MCP y dominio | Ownership, tenant y RLS; tests cruzados de todos los IDs y FKs |
| Inyección de prompt en documentos/productos/resultados | Fuentes tratadas como datos no confiables; allowlist de tools, schemas y policy engine fuera del LLM; ataques en evals |
| Confused deputy / token ajeno | Audience, issuer, expiry, scopes y delegación verificados; no token passthrough |
| Robo de sesión / CSRF | OIDC, cookies HttpOnly/Secure/SameSite, CSRF en mutaciones y comprobación de origen |
| SQL injection / mass assignment | Consultas parametrizadas, enums y comandos de dominio; no SQL/URL arbitrario desde tools |
| SSRF o corpus malicioso | Ingesta sólo fuentes allowlisted, límites MIME/tamaño, sin fetch de URLs propuestas por modelo; revisión antes de publicar |
| Exfiltración por proveedor IA/logs | Minimizar y redactar PII, secretos fuera del contexto, egress limitado, retención explícita |
| TOCTOU / repetición / worker duplicado | Versionado, locks, idempotencia durable y consumo atómico de aprobación |
| DoS / costos descontrolados | Rate limits por tenant/sujeto, presupuestos, colas acotadas y circuit breakers |
| Compromiso de credenciales | Secret manager, roles separados, rotación, sin credenciales en frontend/repositorio |

Para transporte HTTP, el diseño sigue validación de tokens y separación de audiencia descritas en [MCP authorization](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/basic/authorization.mdx). En M5 se fijará una versión de protocolo soportada y se probará interoperabilidad; no se presupone que esta referencia sea la última versión. Fallo de autorización, BD o verificación de aprobación cierra escrituras. Caída de Redis no relaja controles ni rate limits de escrituras: se rechazan hasta recuperar coordinación.
