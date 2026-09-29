## Why

Los agentes sólo deben actuar mediante ocho tools clasificadas, con schemas estrictos, scopes verificados en servidor, auditoría e idempotencia.

## What Changes

- Ocho tools con transporte Streamable HTTP autenticado y versión de protocolo fijada.
- Scopes, consentimientos, minimización de datos y auditoría.
- Ticket idempotente y `update_order` publicado con ejecución cerrada hasta que exista aprobación verificable (M8).

Fuera de alcance: Aprobación humana y consumo de aprobaciones (M8).

## Capabilities

### New Capabilities

- `controlled-mcp`: 2 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M5 (MCP) del [roadmap](../../../docs/roadmap.md); depende de M3, M4. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 6.1–6.3, renumeradas como 1.x).
