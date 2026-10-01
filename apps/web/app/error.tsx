'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <section>
      <h1>Algo falló</h1>
      <p className="notice err" role="alert" data-state="error">
        No se pudo mostrar esta vista. No se ejecutó ninguna acción por este error.
      </p>
      <button
        type="button"
        onClick={() => {
          reset();
        }}
      >
        Reintentar
      </button>
    </section>
  );
}
