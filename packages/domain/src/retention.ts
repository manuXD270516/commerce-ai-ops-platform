import pg from 'pg';

export interface RetentionResult {
  readonly entity: string;
  readonly affected: number;
}

/**
 * Applies the demo retention policy (data-model.md) as the table owner: run state and run inputs
 * after 30 days, decided action requests, approvals and audit after 90 days. The runtime role
 * cannot call it.
 */
export async function applyRetention(
  migratorUrl: string,
  asOf: Date = new Date(),
): Promise<readonly RetentionResult[]> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ entity: string; affected: string }>(
      'SELECT entity, affected FROM commerce.apply_retention($1)',
      [asOf],
    );
    await client.query('COMMIT');
    return rows.map((r) => ({ entity: r.entity, affected: Number(r.affected) }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
