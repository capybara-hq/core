import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  type PendingWrite,
  TASKS,
  WRITES_IDX_MAP,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint_type: string;
  checkpoint: Uint8Array;
  metadata_type: string;
  metadata: Uint8Array;
}

const CHECKPOINT_COLUMNS = [
  "thread_id",
  "checkpoint_ns",
  "checkpoint_id",
  "parent_checkpoint_id",
  "checkpoint_type",
  "checkpoint",
  "metadata_type",
  "metadata",
] as const;

/** checkpoint_id（uuid6）按字节序比较，不受数据库排序规则影响。 */
const idC = sql<string>`checkpoint_id collate "C"`;

/**
 * LangGraph checkpoint saver，存在内核 schema 的 `lg_checkpoints` / `lg_checkpoint_writes` 里（0007_checkpoints.sql）。
 *
 * - 每个 checkpoint 存整份（含全部 channel_values），不按 channel 增量存，所以 {@link pruneToLatest}
 *   之后最新一份仍能独立还原。不要配合实验性的 `DeltaChannel` 使用：它依赖父链上的 writes 还原状态。
 * - thread_id 约定为 runId。
 * - 所有状态都在 PG 里，不持有进程内状态，任意副本都能续跑。
 */
export class KyselyCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: KernelDb) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) return undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = getCheckpointId(config);
    let q = this.db
      .selectFrom("lg_checkpoints")
      .select(CHECKPOINT_COLUMNS)
      .where("thread_id", "=", threadId)
      .where("checkpoint_ns", "=", ns);
    q = checkpointId
      ? q.where("checkpoint_id", "=", checkpointId)
      : q.orderBy(sql`${idC} desc`).limit(1);
    const row = await q.executeTakeFirst();
    return row ? this.toTuple(row) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { before, filter } = options ?? {};
    let { limit } = options ?? {};
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = config.configurable?.checkpoint_ns as string | undefined;
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    const beforeId = before?.configurable?.checkpoint_id as string | undefined;
    const filterEntries = Object.entries(filter ?? {});

    let q = this.db.selectFrom("lg_checkpoints").select(CHECKPOINT_COLUMNS);
    if (threadId !== undefined) q = q.where("thread_id", "=", threadId);
    if (ns !== undefined) q = q.where("checkpoint_ns", "=", ns);
    if (checkpointId) q = q.where("checkpoint_id", "=", checkpointId);
    if (beforeId) q = q.where(idC, "<", beforeId);
    q = q.orderBy(sql`${idC} desc`).orderBy("thread_id").orderBy("checkpoint_ns");
    // metadata 是序列化字节，过滤只能在读出后做；没有过滤条件时 limit 下推到 SQL。
    if (limit !== undefined && filterEntries.length === 0) q = q.limit(Math.max(limit, 0));
    const rows = await q.execute();

    for (const row of rows) {
      if (limit !== undefined && limit <= 0) return;
      const metadata = (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata,
      )) as CheckpointMetadata;
      if (!filterEntries.every(([k, v]) => (metadata as Record<string, unknown>)[k] === v))
        continue;
      if (limit !== undefined) limit -= 1;
      yield this.toTuple(row, metadata);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (threadId === undefined) {
      throw new Error(
        'Failed to put checkpoint: config.configurable is missing the required "thread_id" field.',
      );
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const parentId = (config.configurable?.checkpoint_id as string | undefined) ?? null;
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    const values = {
      parent_checkpoint_id: parentId,
      checkpoint_type: checkpointType,
      checkpoint: Buffer.from(checkpointBytes),
      metadata_type: metadataType,
      metadata: Buffer.from(metadataBytes),
    };
    await this.db
      .insertInto("lg_checkpoints")
      .values({ thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id, ...values })
      .onConflict((oc) =>
        oc.columns(["thread_id", "checkpoint_ns", "checkpoint_id"]).doUpdateSet(values),
      )
      .execute();
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (threadId === undefined) {
      throw new Error(
        'Failed to put writes: config.configurable is missing the required "thread_id" field.',
      );
    }
    if (checkpointId === undefined) {
      throw new Error(
        'Failed to put writes: config.configurable is missing the required "checkpoint_id" field.',
      );
    }
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const rows = await Promise.all(
      writes.map(async ([channel, value], i) => {
        const [valueType, bytes] = await this.serde.dumpsTyped(value);
        return {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpointId,
          task_id: taskId,
          idx: (WRITES_IDX_MAP as Record<string, number>)[channel] ?? i,
          channel,
          value_type: valueType,
          value: Buffer.from(bytes),
          task_path: taskPath ?? "",
        };
      }),
    );
    // 特殊 channel（错误、中断等，idx < 0）以最后一次为准；普通 write 已存在则保留先写入的。
    const special = rows.filter((r) => r.idx < 0);
    const regular = rows.filter((r) => r.idx >= 0);
    const key = ["thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx"] as const;
    await this.db.transaction().execute(async (trx) => {
      if (regular.length > 0) {
        await trx
          .insertInto("lg_checkpoint_writes")
          .values(regular)
          .onConflict((oc) => oc.columns(key).doNothing())
          .execute();
      }
      if (special.length > 0) {
        await trx
          .insertInto("lg_checkpoint_writes")
          .values(special)
          .onConflict((oc) =>
            oc.columns(key).doUpdateSet((eb) => ({
              channel: eb.ref("excluded.channel"),
              value_type: eb.ref("excluded.value_type"),
              value: eb.ref("excluded.value"),
              task_path: eb.ref("excluded.task_path"),
            })),
          )
          .execute();
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("lg_checkpoint_writes").where("thread_id", "=", threadId).execute();
      await trx.deleteFrom("lg_checkpoints").where("thread_id", "=", threadId).execute();
    });
  }

  /**
   * 一轮运行结束后调用：根命名空间（`checkpoint_ns = ''`）下只保留最新一个 checkpoint 及其 writes，
   * 其余 checkpoint 与它们的 writes 删除。返回删除的 checkpoint 条数。其他命名空间（子图）不动。
   * 保留下来的 checkpoint 的 parent_checkpoint_id 原样保留（父 checkpoint 已不存在）。
   */
  async pruneToLatest(threadId: string): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const latest = await trx
        .selectFrom("lg_checkpoints")
        .select("checkpoint_id")
        .where("thread_id", "=", threadId)
        .where("checkpoint_ns", "=", "")
        .orderBy(sql`${idC} desc`)
        .limit(1)
        .executeTakeFirst();
      if (!latest) return 0;
      await trx
        .deleteFrom("lg_checkpoint_writes")
        .where("thread_id", "=", threadId)
        .where("checkpoint_ns", "=", "")
        .where("checkpoint_id", "<>", latest.checkpoint_id)
        .execute();
      const res = await trx
        .deleteFrom("lg_checkpoints")
        .where("thread_id", "=", threadId)
        .where("checkpoint_ns", "=", "")
        .where("checkpoint_id", "<>", latest.checkpoint_id)
        .executeTakeFirst();
      return Number(res.numDeletedRows);
    });
  }

  private async toTuple(
    row: CheckpointRow,
    metadata?: CheckpointMetadata,
  ): Promise<CheckpointTuple> {
    const { thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id } = row;
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpoint_type,
      row.checkpoint,
    )) as Checkpoint;
    if (checkpoint.v < 4 && parent_checkpoint_id !== null) {
      await this.migratePendingSends(checkpoint, thread_id, checkpoint_ns, parent_checkpoint_id);
    }
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id, checkpoint_ns, checkpoint_id } },
      checkpoint,
      metadata:
        metadata ??
        ((await this.serde.loadsTyped(row.metadata_type, row.metadata)) as CheckpointMetadata),
      pendingWrites: (await this.loadWrites(thread_id, checkpoint_ns, checkpoint_id)).map(
        (w) => [w.taskId, w.channel, w.value] satisfies CheckpointPendingWrite,
      ),
    };
    if (parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: { thread_id, checkpoint_ns, checkpoint_id: parent_checkpoint_id },
      };
    }
    return tuple;
  }

  /** 某个 checkpoint 的 writes，按 `writesSortKey`（task_path, task_id, idx）排序。 */
  private async loadWrites(threadId: string, ns: string, checkpointId: string) {
    const rows = await this.db
      .selectFrom("lg_checkpoint_writes")
      .select(["task_id", "idx", "channel", "value_type", "value", "task_path"])
      .where("thread_id", "=", threadId)
      .where("checkpoint_ns", "=", ns)
      .where("checkpoint_id", "=", checkpointId)
      .execute();
    rows.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.idx),
        writesSortKey(b.task_path, b.task_id, b.idx),
      ),
    );
    return Promise.all(
      rows.map(async (r) => ({
        taskId: r.task_id,
        channel: r.channel,
        value: await this.serde.loadsTyped(r.value_type, r.value),
      })),
    );
  }

  /** v < 4 的旧 checkpoint：把父 checkpoint 上的 TASKS writes 迁成本 checkpoint 的 TASKS channel（同 MemorySaver）。 */
  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    ns: string,
    parentId: string,
  ) {
    const sends = (await this.loadWrites(threadId, ns, parentId))
      .filter((w) => w.channel === TASKS)
      .map((w) => w.value);
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = sends;
    checkpoint.channel_versions ??= {};
    const versions = Object.values(checkpoint.channel_versions);
    checkpoint.channel_versions[TASKS] =
      versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
  }
}
