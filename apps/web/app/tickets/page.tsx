import { cookies } from 'next/headers';
import { apiGet, sessionFromCookie } from '../../lib/session';

export default async function TicketsPage() {
  const session = sessionFromCookie((await cookies()).toString());
  const data = (await apiGet(session, '/v1/support-tickets')) as {
    items?: { id: string; summary: string; status: string }[];
  };
  return (
    <section>
      <h1>Tickets</h1>
      {(data.items ?? []).length === 0 ? (
        <p>Bandeja vacía.</p>
      ) : (
        <ul>
          {(data.items ?? []).map((ticket) => (
            <li key={ticket.id}>
              {ticket.status}: {ticket.summary}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
