## Context

Milestone M1. Arquitectura transversal en [architecture.md](../../../docs/architecture.md) §1 (bounded contexts), §4 (idempotencia y concurrencia) y §6 (decisión 7, persistencia); [modelo de datos](../../../docs/data-model.md).

## Goals / Non-Goals

Objetivo: cumplir el gate de salida de M1: Migración limpia; invariantes, FKs y aislamiento negativos; snapshots consistentes. No objetivos: APIs públicas (M2), reservas y detector de anomalías (M3), embeddings (M4) y cualquier tool MCP (M5).

## Decisions

Pendiente. Antes de implementar se registran aquí las decisiones de detalle de este milestone, partiendo de las ya fijadas en architecture.md. Si alguna cambia comportamiento o alcance, se actualizan antes proposal y specs.

## Open Questions

Ninguna abierta en docs/. Fijar antes de implementar: layout de migraciones dentro de `packages/domain`, roles runtime/migrator y formato de fixtures versionados en `evals/fixtures`.
