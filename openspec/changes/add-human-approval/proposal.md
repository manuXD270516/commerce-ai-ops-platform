## Why

La única mutación comercial expuesta (solicitar cancelación) exige aprobación humana vinculada, separación de funciones y consumo atómico.

## What Changes

- ActionRequest/Approval y endpoint de decisión con separación de funciones.
- `update_order` acotado a CANCELLATION_REQUESTED con consumo transaccional.
- Revocación durante la pausa y continuidad tras reinicio sin doble efecto.

Fuera de alcance: Cancelación efectiva, liberación de reservas, reembolsos y confirmación del transportista.

## Capabilities

### New Capabilities

- `commerce-domain`: 1 requisito(s) de este milestone.
- `controlled-mcp`: 3 requisito(s) de este milestone.

### Modified Capabilities

Ninguna.

## Impact

Milestone M8 (Human approval) del [roadmap](../../../docs/roadmap.md); depende de M5, M7. Alcance y exclusiones del MVP en [alcance del MVP](../../../docs/mvp-scope.md). Este change se creó al dividir `define-commerce-ops-mvp`; requisitos y tareas se trasladaron sin cambios de contenido (tareas originales 9.1–9.3, renumeradas como 1.x).
