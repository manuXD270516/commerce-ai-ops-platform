import { cookies } from 'next/headers';
import { DEMO_USERS, sessionFromCookie } from '../lib/session';

export default async function HomePage() {
  const jar = await cookies();
  const session = sessionFromCookie(jar.toString());
  return (
    <section>
      <h1>Consola operacional</h1>
      <p>
        Sesión actual: <strong>{session.label}</strong> ({session.role}). El backend es la
        autoridad.
      </p>
      <form action="/api/session" method="post">
        <label htmlFor="subject">Cambiar usuario de demo</label>{' '}
        <select id="subject" name="subject" defaultValue={session.subjectId}>
          {DEMO_USERS.map((user) => (
            <option key={user.subjectId} value={user.subjectId}>
              {user.label}
            </option>
          ))}
        </select>{' '}
        <button type="submit">Entrar</button>
      </form>
      <ul>
        <li>Customer: catálogo, su orden y tickets. No ve PII ajena ni aprobaciones.</li>
        <li>
          Inventory: balances y anomalías. Sin datos privados de clientes ni decidir aprobaciones.
        </li>
        <li>Approver: bandeja de ActionRequest. Distinto del solicitante.</li>
      </ul>
    </section>
  );
}
