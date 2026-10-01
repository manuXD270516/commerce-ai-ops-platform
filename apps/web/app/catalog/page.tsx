import type { ProductList } from '@commerce/contracts';
import { ApiState, Empty } from '../../components/ApiState';
import { api, requireSession } from '../../lib/api';
import { usd, when } from '../../lib/format';

type Search = Promise<Record<string, string | string[] | undefined>>;

const FILTERS = ['category', 'price_lt', 'ram_gb', 'region'] as const;

export default async function CatalogPage({ searchParams }: { searchParams: Search }) {
  const session = await requireSession();
  const params = await searchParams;
  const query = new URLSearchParams({ currency: 'USD', limit: '50' });
  for (const key of FILTERS) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') query.set(key, value.trim());
  }
  const result = await api<ProductList>(session, `/v1/products?${query.toString()}`);
  const value = (key: (typeof FILTERS)[number]) =>
    typeof params[key] === 'string' ? params[key] : '';
  return (
    <section>
      <h1>Catálogo</h1>
      <p className="muted">
        Filtros aplicados en SQL: sólo productos publicados, USD y precio estrictamente menor al
        límite. Disponibilidad observada al consultar; no es una reserva.
      </p>
      <form className="inline" method="get" aria-label="Filtros de catálogo">
        <label>
          Categoría
          <select name="category" defaultValue={value('category')}>
            <option value="">Todas</option>
            <option value="notebook">Notebook</option>
            <option value="accessory">Accesorio</option>
          </select>
        </label>
        <label>
          Precio menor a (centavos USD)
          <input
            name="price_lt"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={value('price_lt')}
          />
        </label>
        <label>
          RAM (GB)
          <input
            name="ram_gb"
            inputMode="numeric"
            pattern="[0-9]*"
            defaultValue={value('ram_gb')}
          />
        </label>
        <button type="submit">Filtrar</button>
      </form>
      <ApiState result={result} what="el catálogo" />
      {result.ok &&
        (result.body.items.length === 0 ? (
          <Empty>Sin resultados para esos filtros. No se relajan las condiciones.</Empty>
        ) : (
          <table aria-label="Resultados de catálogo">
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Producto</th>
                <th scope="col">Precio</th>
                <th scope="col">RAM</th>
                <th scope="col">Disponible</th>
                <th scope="col">Región</th>
              </tr>
            </thead>
            <tbody>
              {result.body.items.map((sku) => (
                <tr key={`${sku.id}-${sku.region}`}>
                  <td>{sku.sku_code}</td>
                  <td>{sku.title}</td>
                  <td>{usd(sku.price_minor)}</td>
                  <td>{sku.ram_gb ? `${String(sku.ram_gb)} GB` : '—'}</td>
                  <td>{sku.available}</td>
                  <td>{sku.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {result.ok && <p className="muted">Observado: {when(result.body.observed_at)}</p>}
    </section>
  );
}
