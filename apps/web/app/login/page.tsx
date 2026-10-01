import { DEMO_USERS } from '../../lib/session';

export default function LoginPage() {
  return (
    <section>
      <h1>Ingresar (demo local)</h1>
      <p className="muted">
        En local la consola actúa como emisor de desarrollo y firma tokens de corta vida. El rol
        efectivo lo decide la membership en la base de datos. En cloud se reemplaza por OIDC.
      </p>
      <ul>
        {DEMO_USERS.map((u) => (
          <li key={u.subjectId}>
            <form action="/api/session" method="post">
              <input type="hidden" name="subject" value={u.subjectId} />
              <button type="submit">
                {u.label} — {u.role}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
