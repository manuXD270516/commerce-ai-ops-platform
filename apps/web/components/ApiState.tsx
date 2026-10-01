import type { ApiErrorBody, ApiResult } from '../lib/api';

/**
 * Renders the non-happy states of an API read: degraded (API unreachable), forbidden, not found
 * and other errors. Returns null when the result is usable.
 */
export function ApiState({ result, what }: { result: ApiResult<unknown>; what: string }) {
  if (result.ok) return null;
  const body = result.body as ApiErrorBody;
  if (result.unreachable || result.status === 503) {
    return (
      <p className="notice warn" role="status" data-state="degraded">
        Servicio degradado: no se pudo consultar {what}. No muestro datos que no puedo verificar;
        reintentá en unos segundos.
      </p>
    );
  }
  if (result.status === 403) {
    return (
      <p className="notice err" role="status" data-state="forbidden">
        Tu rol no tiene acceso a {what}.
      </p>
    );
  }
  if (result.status === 404) {
    return (
      <p className="notice err" role="status" data-state="not-found">
        No encontrado: {what} no existe o no es accesible para tu usuario.
      </p>
    );
  }
  return (
    <p className="notice err" role="alert" data-state="error">
      Error al consultar {what}: {body.code ?? `HTTP ${String(result.status)}`}
      {body.message ? ` — ${body.message}` : ''}.
    </p>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="notice" role="status" data-state="empty">
      {children}
    </p>
  );
}
