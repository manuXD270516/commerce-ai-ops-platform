# Verification

## Estado de esta entrega

Fase: documentación previa a implementación. Proposal, delta specs, design y tasks redactados. No se ejecutaron pruebas de producto, evals, build, migraciones ni deployment porque no hay implementación. Ningún gate funcional se considera aprobado.

Validación documental ejecutada el 2026-09-23: `openspec validate define-commerce-ops-mvp --strict` terminó con exit code 0 y resultado `Change 'define-commerce-ops-mvp' is valid`. La validación de formato no demuestra comportamiento del sistema.

## Revisión de diseño previa a M0

Realizada el 2026-09-29, requisito "Diseño revisado" de M0 en docs/roadmap.md. Alcance: coherencia entre design.md, docs/ y specs, y decisiones que bloqueaban el bootstrap (gestor y workspaces, runtime, versiones de Next.js/NestJS/LangGraph JS, persistencia y migraciones, formato de contratos, estrategia de tests, observabilidad, entorno local y CI). Resultado: 16 decisiones registradas en design.md §6, ninguna altera comportamiento ni alcance funcional. Pendiente derivado: reformular el escenario "Documentation-only delivery" antes de archivar.

## Matriz de trazabilidad prevista

| Capability | Milestones/tareas | Evidencia que exigirá implementación |
|---|---|---|
| commerce-domain | M1–M3, M8; 2.*, 3.*, 4.1–4.2, 9.2 | Integración PostgreSQL, constraints/RLS, concurrencia, estados y snapshots |
| hybrid-retrieval | M4; 5.* | Corpus versionado, ACL, SQL eligibility, recall, citas, retiro e inyección |
| controlled-mcp | M5/M8; 6.*, 9.* | Contratos de ocho tools; consentimiento, tokens, replay, TTL, revocación y atomicidad |
| agent-workflows | M3/M6/M7; 4.3, 7.*, 8.* | Routing, tres workflows, presupuestos, degradación y restart |
| operations-console | M9; 10.* | E2E por rol, estados, teclado, aprobación y reconexión |
| evaluation-observability | M0/M10/M11; 1.*, 11.*, 12.* | Reportes con diez métricas, trazas, seguridad, carga, rollback y restore |

## Checklist documental

- Los nueve puntos solicitados se distribuyen entre design.md y docs/data-model.md, agents-security-mcp.md, rag-evals.md y roadmap.md.
- Los ocho nombres de tools se conservan y tienen clasificación explícita.
- Las acciones privilegiadas requieren aprobación humana externa al agente.
- La investigación no autoriza escrituras por sí sola; request_cancellation no equivale a cancelación efectiva.
- Todos los umbrales son propuestos; fuentes logísticas simuladas están identificadas.
- Todas las tareas de implementación y verificación funcional permanecen sin marcar.

## Gate final del MVP (pendiente)

Todas las tareas completadas con evidencia, escenarios vinculados a tests, gates de docs/rag-evals.md aprobados y demo reproducible. Cualquier lectura/acción indebida bloquea release. El reporte final incluirá commit, entorno, versiones, fixtures, denominadores, fallos y limitaciones conocidas. Sólo tras esta evidencia se archiva el change y se promueven delta specs a especificaciones principales.
