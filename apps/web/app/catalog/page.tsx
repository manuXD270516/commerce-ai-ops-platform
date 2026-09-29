import { cookies } from 'next/headers';
import { apiGet, sessionFromCookie } from '../../lib/session';

export default async function CatalogPage() {
  const session = sessionFromCookie((await cookies()).toString());
  const data = (await apiGet(
    session,
    '/v1/products?category=notebook&currency=USD&price_lt=150000&region=us-east',
  )) as { items?: { sku_code: string; price_minor: number; available: number }[] };
  const items = data.items ?? [];
  return (
    <section>
      <h1>Catálogo</h1>
      <p>Filtro estricto: notebook USD &lt; 1.500. Vacío si no hay candidatos.</p>
      {items.length === 0 ? (
        <p>Sin resultados.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Precio (minor)</th>
              <th>Disponible</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.sku_code}>
                <td>{row.sku_code}</td>
                <td>{row.price_minor}</td>
                <td>{row.available}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
