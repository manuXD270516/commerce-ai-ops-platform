## Why

API, MCP, retrieval y agentes necesitan antes un modelo relacional con aislamiento por tenant, estados, snapshots, auditoría e idempotencia en PostgreSQL.

## What Changes

- Schema y migraciones SQL forward-only con FKs compuestas por tenant, importes en centavos y snapshots de compra.
- Identidad, membership, ownership y RLS con fixtures sintéticos de dos tenants.
- Outbox, inbox, auditoría e idempotencia transaccionales.

Fuera de alcance: APIs públicas (M2), reservas y detector de anomalías (M3), embeddings (M4) y cualquier tool MCP (M5).

## Capabilities

### New Capabilities

- `commerce-domain`: 1 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M1 (Commerce domain model) del [roadmap](../../../docs/roadmap.md); depende de M0. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 2.1–2.3, renumeradas como 1.x).
