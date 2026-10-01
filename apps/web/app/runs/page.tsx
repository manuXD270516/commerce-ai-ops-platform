import { StartRunForm } from '../../components/StartRunForm';
import { requireSession } from '../../lib/api';

type Search = Promise<Record<string, string | string[] | undefined>>;

const EXAMPLES: Record<string, string[]> = {
  customer: [
    'Mi pedido 00000000-0000-4000-8000-000000000401 está atrasado, ¿qué pasa?',
    'Recomiéndame una notebook de desarrollo por menos de USD 1.500',
  ],
  support: ['El cliente pregunta por el pedido 00000000-0000-4000-8000-000000000401'],
  inventory: ['Explícame la discrepancia de inventario de NB-DEV-32'],
  approver: ['Estado de la orden 00000000-0000-4000-8000-000000000402'],
};

export default async function RunsPage({ searchParams }: { searchParams: Search }) {
  const session = await requireSession();
  const params = await searchParams;
  const order =
    typeof params.order === 'string' && /^[0-9a-f-]{36}$/i.test(params.order)
      ? params.order
      : undefined;
  return (
    <section>
      <h1>Asistente</h1>
      <p className="muted">
        El asistente consulta órdenes, recomienda productos elegibles y explica alertas usando sólo
        datos autorizados para tu usuario. No ejecuta acciones sin tu confirmación ni sin aprobación
        humana cuando corresponde.
      </p>
      <StartRunForm initialMessage={order ? `¿Qué pasa con mi pedido ${order}?` : ''} />
      {(EXAMPLES[session.role] ?? []).length > 0 && (
        <>
          <h2>Ejemplos</h2>
          <ul>
            {(EXAMPLES[session.role] ?? []).map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
