import type { RunnableConfig } from '@langchain/core/runnables';
import {
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { withUnitOfWork, type ActorContext, type DomainDb } from '@commerce/domain';
import { sql } from 'kysely';

/**
 * LangGraph checkpointer backed by commerce.graph_checkpoints / graph_writes under tenant RLS.
 *
 * It reuses MemorySaver's read logic over an in-memory mirror that is hydrated from PostgreSQL for
 * one thread (= one agent run) before the graph runs, and writes every new checkpoint and pending
 * write through to PostgreSQL before returning. A new process can therefore hydrate the same
 * thread and resume from the last durable checkpoint.
 */
export class TenantCheckpointSaver extends MemorySaver {
  private constructor(
    private readonly db: DomainDb,
    private readonly ctx: ActorContext,
    private readonly threadId: string,
  ) {
    super();
  }

  static async forThread(
    db: DomainDb,
    ctx: ActorContext,
    threadId: string,
  ): Promise<TenantCheckpointSaver> {
    const saver = new TenantCheckpointSaver(db, ctx, threadId);
    await saver.hydrate();
    return saver;
  }

  private async hydrate(): Promise<void> {
    const { checkpoints, writes } = await withUnitOfWork(this.db, this.ctx, async (trx) => ({
      checkpoints: await trx
        .selectFrom('graph_checkpoints')
        .selectAll()
        .where('thread_id', '=', this.threadId)
        .execute(),
      writes: await trx
        .selectFrom('graph_writes')
        .selectAll()
        .where('thread_id', '=', this.threadId)
        .execute(),
    }));
    for (const row of checkpoints) {
      const byNs = (this.storage[this.threadId] ??= Object.create(null) as Record<
        string,
        Record<string, [Uint8Array, Uint8Array, string | undefined]>
      >);
      const byId = (byNs[row.checkpoint_ns] ??= Object.create(null) as Record<
        string,
        [Uint8Array, Uint8Array, string | undefined]
      >);
      byId[row.checkpoint_id] = [
        new Uint8Array(row.checkpoint),
        new Uint8Array(row.metadata),
        row.parent_checkpoint_id ?? undefined,
      ];
    }
    for (const row of writes) {
      const outer = JSON.stringify([this.threadId, row.checkpoint_ns, row.checkpoint_id]);
      const bucket = (this.writes[outer] ??= Object.create(null) as Record<
        string,
        [string, string, Uint8Array]
      >);
      bucket[row.write_key] = [row.task_id, row.channel, new Uint8Array(row.value)];
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.assertThread(config);
    const result = await super.put(config, checkpoint, metadata);
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const stored = this.storage[this.threadId]?.[ns]?.[checkpoint.id];
    if (!stored) throw new Error('checkpoint was not stored');
    const [serialized, serializedMetadata, parent] = stored;
    await withUnitOfWork(this.db, this.ctx, async (trx) => {
      await trx
        .insertInto('graph_checkpoints')
        .values({
          tenant_id: this.ctx.tenantId,
          thread_id: this.threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpoint.id,
          parent_checkpoint_id: parent ?? null,
          checkpoint: Buffer.from(serialized),
          metadata: Buffer.from(serializedMetadata),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'thread_id', 'checkpoint_ns', 'checkpoint_id']).doNothing(),
        )
        .execute();
    });
    return result;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.assertThread(config);
    await super.putWrites(config, writes, taskId);
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
    const checkpointId = config.configurable?.checkpoint_id as string;
    const outer = JSON.stringify([this.threadId, ns, checkpointId]);
    const bucket = this.writes[outer] ?? {};
    const rows = Object.entries(bucket)
      .filter(([, [task]]) => task === taskId)
      .map(([key, [task, channel, value]]) => ({
        tenant_id: this.ctx.tenantId,
        thread_id: this.threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpointId,
        write_key: key,
        task_id: task,
        channel,
        value: Buffer.from(value),
      }));
    if (rows.length === 0) return;
    await withUnitOfWork(this.db, this.ctx, async (trx) => {
      await trx
        .insertInto('graph_writes')
        .values(rows)
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'thread_id', 'checkpoint_ns', 'checkpoint_id', 'write_key'])
            .doUpdateSet({ channel: sql`excluded.channel`, value: sql`excluded.value` }),
        )
        .execute();
    });
  }

  override deleteThread(): Promise<void> {
    // Run history is retained for audit (data-model.md); deletion belongs to retention jobs.
    return Promise.reject(new Error('graph checkpoints are not deleted by the runtime'));
  }

  private assertThread(config: RunnableConfig): void {
    if (config.configurable?.thread_id !== this.threadId) {
      throw new Error('checkpointer is bound to a single run');
    }
  }
}
