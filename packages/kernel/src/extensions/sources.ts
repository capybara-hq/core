import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";

/**
 * Where an extension comes from (C14 / C15 / C13):
 * - `builtin`: passed in by the CLI as `builtinExtensions` (`openai-compatible`, `object-store-s3`),
 *   pre-approved, always enabled, no permission review, no org enablement needed, cannot be
 *   uninstalled / disabled / upgraded from the web;
 * - `config`: the startup config's `plugins` list (development mode and existing deployments),
 *   read-only in the admin console;
 * - `install`: PG install records (`extension_installs`), the package in the content-addressed package
 *   store, synced to local disk by each replica before loading.
 * On a name clash builtin > config > install, and the skipped one warns.
 */
export type ExtensionSource = "builtin" | "config" | "install";

/** 副本（进程）id：`<hostname>-<pid>-<6 位随机>`，每个进程唯一（`http.replicaId` 可能跨重启不变或多副本相同）。 */
export function newReplicaId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

/** Why `extension_replica_status.state = pending` (F-I: the admin view derives pending_config and so on from it). */
export type PendingReason = "config" | "approval" | "migration" | "dependency";

/** One load result (written to `extension_replica_status`). */
export interface ExtensionLoadStatus {
  plugin: string;
  version: string;
  sha256: string | null;
  source: ExtensionSource;
  /** `unloaded`：本进程撤销了它（停用 / 卸载，或随提供方卸下时 reason 为 `dependency`）。停机时删掉本副本的行。 */
  state: "loaded" | "failed" | "pending" | "unloaded";
  reason: PendingReason | string | null;
  detail: string | null;
  /**
   * 这一行的版本没加载成（failed / pending）而本副本仍在用旧版本（升级失败或待批准时旧版照常）时，旧版本号。
   * 省略视同 null。
   */
  servingVersion?: string | null;
}

/** detail 的长度上限（报错信息可能很长）。 */
const MAX_DETAIL = 2000;

/** This replica's extension load status (PG `extension_replica_status`; each replica writes only its own rows). */
export class ReplicaStatusStore {
  /** 本进程写过行（停机时才需要删；没写过时不碰数据库，例如启动在迁移前就失败）。 */
  private wrote = false;

  /**
   * @param redact 写 `detail` 之前打码（内核传 logger 的 `redact`：报错信息里可能带着插件拼进去的密钥）。
   */
  constructor(
    private readonly db: KernelDb,
    readonly replicaId: string,
    private readonly httpReplicaId?: string,
    private readonly redact: (text: string) => string = (t) => t,
  ) {}

  /** 打码后截断到 {@link MAX_DETAIL}。 */
  private cleanDetail(detail: string): string {
    return this.redact(detail).slice(0, MAX_DETAIL);
  }

  /** 写入（覆盖）本副本该插件的一行，心跳取当前时间。 */
  async write(s: ExtensionLoadStatus): Promise<void> {
    this.wrote = true;
    const values = {
      replica_id: this.replicaId,
      plugin: s.plugin,
      version: s.version,
      sha256: s.sha256,
      source: s.source,
      state: s.state,
      reason: s.reason,
      detail: s.detail === null ? null : this.cleanDetail(s.detail),
      serving_version: s.servingVersion ?? null,
      http_replica_id: this.httpReplicaId ?? null,
      heartbeat_at: sql<Date>`now()` as unknown as Date,
    };
    await this.db
      .insertInto("extension_replica_status")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["replica_id", "plugin"]).doUpdateSet({
          version: values.version,
          sha256: values.sha256,
          source: values.source,
          state: values.state,
          reason: values.reason,
          detail: values.detail,
          serving_version: values.serving_version,
          http_replica_id: values.http_replica_id,
          heartbeat_at: values.heartbeat_at,
        }),
      )
      .execute();
  }

  /**
   * 给本副本该插件已有的一行补一句说明（不改状态），如「同名安装记录被忽略」。
   * 该插件这一行属于生效的那一方（内置 / 配置声明），所以只追加 detail。
   */
  async note(plugin: string, detail: string): Promise<void> {
    await this.db
      .updateTable("extension_replica_status")
      .set({ detail: this.cleanDetail(detail) })
      .where("replica_id", "=", this.replicaId)
      .where("plugin", "=", plugin)
      .execute();
  }

  /**
   * 心跳：本副本全部行的 `heartbeat_at` 取当前时间（每次 reconcile 之后调用；读状态的一方只算心跳不超过
   * 3 个 reconcile 周期的副本，C16）。
   */
  async heartbeat(): Promise<void> {
    if (!this.wrote) return;
    await this.db
      .updateTable("extension_replica_status")
      .set({ heartbeat_at: sql<Date>`now()` as unknown as Date })
      .where("replica_id", "=", this.replicaId)
      .execute();
  }

  /**
   * 清理：删掉本副本已不认识的插件的行（卸载后的名字，`keep` 为部署此刻已知的插件名），以及任何副本心跳超过
   * `staleSeconds` 的行（副本已退出或崩溃；读的一方本来就不计入它们）。返回删除的行数。
   */
  async prune(keep: readonly string[], staleSeconds: number): Promise<number> {
    let n = 0;
    if (this.wrote) {
      let q = this.db
        .deleteFrom("extension_replica_status")
        .where("replica_id", "=", this.replicaId);
      if (keep.length > 0) q = q.where("plugin", "not in", [...keep]);
      n += Number((await q.executeTakeFirst()).numDeletedRows);
    }
    const r = await this.db
      .deleteFrom("extension_replica_status")
      .where("heartbeat_at", "<", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
      .executeTakeFirst();
    return n + Number(r.numDeletedRows);
  }

  /**
   * 正常停机：删掉本副本的全部行（尽力而为）。副本已不在，不该再计入部署状态（否则停机后约 3 个 reconcile
   * 周期里一直显示「收敛中」）；崩溃的副本由 {@link prune} 按心跳清理。
   */
  async removeAll(): Promise<void> {
    if (!this.wrote) return;
    await this.db
      .deleteFrom("extension_replica_status")
      .where("replica_id", "=", this.replicaId)
      .execute();
  }
}
