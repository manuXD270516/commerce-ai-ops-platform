import Link from 'next/link';

export default function NotFound() {
  return (
    <section>
      <h1>No encontrado</h1>
      <p data-state="not-found">Esta página no existe.</p>
      <Link href="/">Volver al inicio</Link>
    </section>
  );
}
