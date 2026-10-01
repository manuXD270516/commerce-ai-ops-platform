export function usd(minor: number): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'USD' }).format(minor / 100);
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'En cola',
  RUNNING: 'Ejecutando',
  WAITING_HUMAN: 'Esperando decisión humana',
  COMPLETED: 'Completado',
  FAILED: 'Falló',
  CANCELLED: 'Run detenido',
  PENDING: 'Pendiente de aprobación',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  EXPIRED: 'Vencida',
  STALE: 'Desactualizada',
  EXECUTED: 'Cancelación solicitada',
};
