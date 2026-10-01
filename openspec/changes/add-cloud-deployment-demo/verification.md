# Verification

## Estado

Stack production-like local ejecutado y ensayado (2026-10-01). **Despliegue cloud pendiente**: espera autorización del dueño del repo y un host de costo cero; el IaC no fue aplicado ni validado. **No archivado** (tarea 1.1 abierta).

## Evidencia exigida

Gate de salida (roadmap): Smoke con 3 casos, rollback y restart; restauración ensayada; costo/latencia etiquetados.

## Resultados

Reportes en [`evidence/`](evidence/). Una sola estación (Windows 11, Docker Desktop); tiempos de una observación, **no SLA**. Proveedor de síntesis por plantilla (SIMULATED), sin LLM: costo de inferencia 0 por construcción.

### Demo (`pnpm prod:demo`) — 18/18

[`m11-demo-…-7c27.md`](evidence/m11-demo-20261001T220134-7c27.md). Todo a través de `https://localhost:8443` con la CA de Caddy confiada explícitamente.

| Paso | Resultado | Tiempo observado |
|---|---|---|
| TLS, HSTS/nosniff, MCP no expuesto, 401 sin token, cookie Secure/HttpOnly/SameSite=Strict | pass | — |
| Caso 1: estado de orden con evidencia | COMPLETED/ANSWERED | 1.257 ms |
| Caso 2: recomendación bajo presupuesto | ANSWERED con NB-DEV-32 | 467 ms |
| Caso 3: discrepancia de inventario, sin cambiar stock | ANSWERED, balances idénticos | 442 ms |
| Aprobación: WAITING_HUMAN → PENDING → requester 403 → approver → ACTION_EXECUTED, una ejecución, trail completo | pass | 1.396 ms |
| Replay: confirmación repetida con la misma clave devuelve la misma solicitud; SSE con Last-Event-ID sólo eventos posteriores, sin run nuevo | pass | — |

### Ensayos (`pnpm prod:drill`) — 21/21

[`m11-recovery-drill-…-92d2.md`](evidence/m11-recovery-drill-20261001T220142-92d2.md).

| Ensayo | Verificado | Tiempos observados |
|---|---|---|
| Redis (estado de coordinación perdido) | readyz 503; API acepta run (202) y decisión durante el corte; rate limit de tickets aplicado desde PostgreSQL (5/5, luego BUDGET_EXCEEDED); al volver, run y acción aprobada completan; 1 aprobación, 1 ejecución, 1 evento `completed` por run; schedulers re-registrados | aceptar run con Redis caído 1.519 ms (timeout de dispatch); corte 6,9 s; recuperación 1,3 s tras volver Redis |
| Restart api + worker | ready vía edge; run nuevo completa | 4,6 s |
| Rollback | imagen de API rota rechazada por el gate de health; tag inmutable anterior sirve de nuevo; datos intactos | detección 2,7 s; restauración 4,7 s |
| Backup/restore aislado | pg_dump (187 KiB) restaurado en PostgreSQL sin red externa; conteos por tabla, estado de runs, último evento de auditoría, 72 FKs validadas sin huérfanos, 45 políticas en 36 tablas con RLS, 9 migraciones | dump 0,46 s; instancia lista 3,1 s; pg_restore 0,7 s; total 4,9 s |
| Persistencia del estado | ningún ensayo resetea datos (agent_runs 4 → 7) | — |

Hallazgo corregido durante el primer ensayo: el job `migrate` se re-ejecutaba en cada `compose start` de un dependiente y su seed borraba los datos. Ahora `seed --if-empty`; el drill lo verifica.

### No hecho

- Despliegue cloud: Terraform y `deploy.yml` escritos, **no aplicados, no validados** (Terraform no instalado) y nunca ejecutados. Pendiente de región, presupuesto, OIDC, certificado y autorización; la topología propuesta no es gratuita.
- Job `prod-like` de CI añadido pero no ejecutado (GitHub Actions bloqueado por billing).
- Restore de snapshot gestionado (RDS) no ensayado; sólo pg_dump/pg_restore local.
