# commerce-ai-ops-platform

Plataforma de operaciones e-commerce con APIs de dominio, búsqueda híbrida, workflows asistidos por IA y acciones auditables mediante MCP.

**Estado: diseño del MVP; no hay implementación.** Datos de demostración sintéticos, USD, una región logística y dos tenants de prueba para verificar aislamiento. Transportistas y notificaciones serán simulados y visibles como tales. PostgreSQL contendrá datos relacionales operativos; las respuestas no dependerán de hechos inventados por el modelo.

## Documentación

- [Propuesta MVP](openspec/changes/define-commerce-ops-mvp/proposal.md)
- [Arquitectura, bounded contexts y decisiones](openspec/changes/define-commerce-ops-mvp/design.md)
- [Modelo de datos](docs/data-model.md)
- [Agentes, permisos MCP y seguridad](docs/agents-security-mcp.md)
- [RAG y evaluaciones](docs/rag-evals.md)
- [Roadmap M0–M11](docs/roadmap.md)
- [Tareas pendientes](openspec/changes/define-commerce-ops-mvp/tasks.md)
- [Plan y estado de verificación](openspec/changes/define-commerce-ops-mvp/verification.md)

## Flujo de trabajo

Cada feature sigue proposal → spec → design → tasks → implementation → verification. El change inicial define el contrato transversal del MVP y su ejecución incremental. Cualquier variación funcional requiere actualizar estos artefactos antes de implementar; nuevas capacidades requieren su propio change. Los delta specs permanecen en el change hasta verificar y archivar. No se declara M0 completado por haber redactado documentación.

No se han instalado dependencias, generado aplicaciones, provisionado cloud ni llamado proveedores de IA. Los umbrales de evaluación son objetivos propuestos, no resultados medidos.
