import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";

/**
 * 插件的来源（C14 / C15 / C13）：
 * - `builtin`：CLI 以 `builtinPlugins` 传入（`openai-compatible`、`object-store-s3`），预先批准、始终启用，
 *   不进权限审批、不需组织启用，不能卸载 / 停用 / 网页升级；
 * - `config`：启动配置的 `plugins` 列表（开发模式与已有部署），后台只读；
 * - `install`：PG 安装记录（`plugin_installs`），包在内容寻址的包存储里，各副本同步到本地后加载。
 * 重名时以 builtin > config > install 为准，被跳过的一方告警。
 */
export type PluginSource = "builtin" | "config" | "install";

/** 副本（进程）id：`<hostname>-<pid>-<6 位随机>`，每个进程唯一（`http.replicaId` 可能跨重启不变或多副本相同）。 */
export function newReplicaId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

/** `plugin_replica_status.state = pending` 的原因（F-I：后台再推导为 pending_config 等）。 */
export type PendingReason = "config" | "approval" | "migration" | "dependency";

/** 一次加载结果（写进 `plugin_replica_status`）。 */
export interface PluginLoadStatus {
  plugin: string;
  version: string;
  sha256: string | null;
  source: PluginSource;
  /** `unloaded`：本进程撤销了它（停用 / 卸载，或随提供方卸下时 reason 为 `dependency`）；停机时全部标为它。 */
  state: "loaded" | "failed" | "pending" | "unloaded";
  reason: PendingReason | string | null;
  detail: string | null;
}

/** detail 的长度上限（报错信息可能很长）。 */
const MAX_DETAIL = 2000;

/** 本副本的插件加载状态（PG `plugin_replica_status`，每个副本只写自己的行）。 */
export class ReplicaStatusStore {
  /** 本进程写过行（停机时才需要标 unloaded；没写过时不碰数据库，例如启动在迁移前就失败）。 */
  private wrote = false;

  constructor(
    private readonly db: KernelDb,
    readonly replicaId: string,
    private readonly httpReplicaId?: string,
  ) {}

  /** 写入（覆盖）本副本该插件的一行，心跳取当前时间。 */
  async write(s: PluginLoadStatus): Promise<void> {
    this.wrote = true;
    const values = {
      replica_id: this.replicaId,
      plugin: s.plugin,
      version: s.version,
      sha256: s.sha256,
      source: s.source,
      state: s.state,
      reason: s.reason,
      detail: s.detail === null ? null : s.detail.slice(0, MAX_DETAIL),
      http_replica_id: this.httpReplicaId ?? null,
      heartbeat_at: sql<Date>`now()` as unknown as Date,
    };
    await this.db
      .insertInto("plugin_replica_status")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["replica_id", "plugin"]).doUpdateSet({
          version: values.version,
          sha256: values.sha256,
          source: values.source,
          state: values.state,
          reason: values.reason,
          detail: values.detail,
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
      .updateTable("plugin_replica_status")
      .set({ detail: detail.slice(0, MAX_DETAIL) })
      .where("replica_id", "=", this.replicaId)
      .where("plugin", "=", plugin)
      .execute();
  }

  /** 停机：本副本的全部行标为 unloaded（尽力而为）。 */
  async markAllUnloaded(): Promise<void> {
    if (!this.wrote) return;
    await this.db
      .updateTable("plugin_replica_status")
      .set({
        state: "unloaded",
        reason: null,
        detail: null,
        heartbeat_at: sql<Date>`now()` as unknown as Date,
      })
      .where("replica_id", "=", this.replicaId)
      .execute();
  }
}
