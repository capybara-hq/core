import {
  type AuthInjection,
  type Logger,
  type ToolAnnotations,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { Maintenance } from "../runtime/maintenance.js";
import { type AppAuth, CredentialMissing, type Credentials, isOAuth } from "./credentials.js";
import { toolKey, toolKeyIssue } from "./naming.js";
import { redactDeep, redactorFor } from "./redact.js";
import { policyFromAnnotations, specHash, type ToolRegistry } from "./registry.js";
import { resourceToolSpecs } from "./resources.js";
import { recordToolSpecs } from "./specs.js";

/**
 * 工具定义漂移检测（spec 7.3：新增 / 变化的工具在组织管理员复核前不可用，防 rug-pull / 工具投毒）。
 *
 * 与上次快照比对：新增 → 插入 `pending_review`；定义（spec_hash 或来源）变化 → `pending_review`，新定义存
 * `pending_spec`，旧定义留在 `spec` 供对比，复核通过才采用；消失 → `disabled` 并记 `missing_since`（行保留，
 * 又出现时按新增处理）。定义不合规（key 不合法等）的工具只能停用：新增 / 变化时直接采用新定义并停用。
 * 应用从未拍过快照（`tools_synced_at` 为空且没有工具行，即 OAuth 授权码应用安装时不 listTools，A16）时，
 * 首个快照按安装处理（直接启用）。
 *
 * 触发：维护队列的周期扫描（`tools.driftIntervalHours`）、连接器在会话中报告工具清单变了（MCP
 * `notifications/tools/list_changed`）、管理员手动刷新（`AppsService.refresh`，走同一套比对）。
 * 授权（`tool_grants` / `conversation_tool_grants`）按 spec_hash 比对（D8），复核通过采用新指纹后旧授权自然失效。
 */

/** 周期扫描：任务名与 job scheduler id（不含 `:`）。 */
export const DRIFT_SCAN_JOB = "drift-scan";
export const DRIFT_SCHEDULER_ID = "drift-scan-interval";
/** 单个应用的漂移检查任务名。 */
export const DRIFT_APP_JOB = "drift-app";

/**
 * list_changed 触发的检查：jobId 按应用与分钟桶去重（同一分钟内多次通知只检查一次；appId 为 UUID，不含 `:`）。
 */
export const listChangedJobId = (appId: string, now = Date.now()): string =>
  `drift-${appId}-${Math.floor(now / 60_000)}`;

/** 周期扫描投递的检查：jobId 按应用与扫描周期桶去重（同一周期内重复扫描只检查一次）。 */
export const driftScanJobId = (appId: string, bucket: number): string =>
  `drift-${appId}-scan-${bucket}`;

/** 个人凭据型应用：最多依次尝试几个成员的凭据。 */
export const PERSONAL_CANDIDATES = 3;

export type DriftTrigger = "schedule" | "list_changed";

export interface DriftChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export type DriftCheckResult =
  | { status: "checked"; changes: DriftChanges }
  | {
      status: "skipped";
      reason: "not_found" | "inactive" | "no_connector" | "no_credential" | "connect_failed";
    };

type Trx = Transaction<KernelDatabase>;
type ToolSource = "connector" | "resources";

/** 快照中被停用 / 跳过的工具及英文原因。 */
export interface ToolIssue {
  name: string;
  reason: string;
}

export interface SnapshotRow {
  name: string;
  spec: ToolSpec;
  specHash: string;
  /** key 不合法 / 定义不合规时为原因，此时工具只能停用。 */
  issue: string | null;
  source: ToolSource;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const errName = (e: unknown): string =>
  e instanceof Error && typeof e.name === "string" && e.name !== "" ? e.name : "Error";

/** 连接失败说明里带上的 ToolError 消息最多字符数。 */
const MAX_FAILURE_DETAIL = 500;

/**
 * 连接 / 列工具失败的说明：ToolError 的消息是连接器写给人看的英文说明（如「Swagger 2.0 不支持」），
 * 按本次注入的凭据打码、截断后带上；其他错误只给错误类名（详情进日志）。
 */
export function connectFailedMessage(e: unknown, redact: (s: string) => string): string {
  if (e instanceof ToolError) {
    return `Could not list tools from the app: ${redact(e.message).slice(0, MAX_FAILURE_DETAIL)}`;
  }
  return `Could not list tools from the app (${errName(e)})`;
}

/**
 * 把连接器返回的工具清单整理成快照：只保留 `name / description / inputSchema / annotations / connectorData`
 * （应用工具不得自带 `defaultPolicy`），同名的后者丢弃；key 超长 / 含非法字符或定义不合规的工具
 * 照样入库但只能停用，并给出原因——一个坏工具不挡住整个应用。名字不是非空字符串的无法入库，只报原因。
 */
export function snapshot(
  slug: string,
  specs: unknown,
  resources: boolean,
): { rows: SnapshotRow[]; issues: ToolIssue[] } {
  const rows: SnapshotRow[] = [];
  const issues: ToolIssue[] = [];
  if (!Array.isArray(specs)) {
    throw new ApiError("app.connect_failed", "The app returned an invalid tool list");
  }
  const seen = new Set<string>();
  for (const raw of specs) {
    const s = isObj(raw) ? raw : {};
    const name = s.name;
    if (typeof name !== "string" || name === "" || name.length > 200) {
      issues.push({
        name: typeof name === "string" ? name.slice(0, 200) : String(name),
        reason: "Tool name must be a non-empty string of at most 200 characters",
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({ name, reason: "Duplicate tool name; only the first one is kept" });
      continue;
    }
    seen.add(name);
    const spec: ToolSpec = {
      name,
      description: typeof s.description === "string" ? s.description : "",
      inputSchema: isObj(s.inputSchema) ? s.inputSchema : {},
      ...(isObj(s.annotations) && { annotations: s.annotations as ToolAnnotations }),
      // 连接器的不透明数据（Ruling A21）：进快照与指纹，调用时交回连接器；不发给模型
      ...(isObj(s.connectorData) && { connectorData: s.connectorData }),
    };
    let issue = toolKeyIssue(toolKey(slug, name));
    if (!issue && !isObj(s.inputSchema)) issue = "Tool inputSchema must be an object";
    if (issue) issues.push({ name, reason: issue });
    rows.push({ name, spec, specHash: specHash(spec), issue, source: "connector" });
  }
  // 应用支持 resources：补上 list_resources / read_resource；连接器自己的同名工具优先
  if (resources) {
    for (const spec of resourceToolSpecs()) {
      if (seen.has(spec.name)) {
        issues.push({
          name: spec.name,
          reason: `The app has its own tool named ${spec.name}; the built-in resource tool is not added`,
        });
        continue;
      }
      const issue = toolKeyIssue(toolKey(slug, spec.name));
      if (issue) issues.push({ name: spec.name, reason: issue });
      rows.push({ name: spec.name, spec, specHash: specHash(spec), issue, source: "resources" });
    }
  }
  return { rows, issues };
}

/** 工具当前不能启用的原因（视图、启用与复核校验共用）。 */
export function toolIssue(slug: string, spec: ToolSpec): string | null {
  const keyIssue = toolKeyIssue(toolKey(slug, spec.name));
  if (keyIssue) return keyIssue;
  if (!isObj(spec.inputSchema)) return "Tool inputSchema must be an object";
  return null;
}

export interface ToolDriftDeps {
  db: KernelDb;
  registry: Pick<ToolRegistry, "findConnector">;
  credentials: Pick<Credentials, "injection" | "onUnauthorized" | "personalHolders">;
  config: () => KernelConfig;
  log: Logger;
  /** 维护队列（登记周期扫描与检查任务的处理函数；不给时只能同步调用 `check`）。 */
  maintenance?: Pick<Maintenance, "add" | "handle" | "schedule">;
}

interface AppRow {
  id: string;
  org_id: string;
  slug: string;
  connector: string;
  endpoint: unknown;
  auth: unknown;
  status: "active" | "disabled";
  created_by: string;
  tools_synced_at: Date | null;
}

/** 任务保留时长：完成的 jobId 留一段时间，同一桶内的重复投递被 BullMQ 按 jobId 去重。 */
const KEEP_FAILED = { age: 86_400 };

export class ToolDrift {
  constructor(private readonly d: ToolDriftDeps) {
    const m = d.maintenance;
    if (m) {
      m.schedule({
        id: DRIFT_SCHEDULER_ID,
        name: DRIFT_SCAN_JOB,
        everyMs: () => this.intervalMs(),
      });
      m.handle(DRIFT_SCAN_JOB, async () => {
        const n = await this.scan();
        if (n > 0) d.log.info("tool drift checks enqueued", { count: n });
      });
      m.handle(DRIFT_APP_JOB, async (job) => {
        const { orgId, appId, trigger } = job.data as {
          orgId: string;
          appId: string;
          trigger: DriftTrigger;
        };
        await this.check(orgId, appId, trigger);
      });
    }
  }

  private intervalMs(): number {
    return this.d.config().tools.driftIntervalHours * 3_600_000;
  }

  /**
   * 打开一次会话拉工具清单，无论成败都关闭会话；会话带 `listResources` 即视为支持 resources。
   * 清单里回显的凭据按本次注入的值打码（见 redact.ts）。凭据缺失原样抛 `credential.missing`；
   * 其余失败一律 502 `app.connect_failed`，消息只带上游错误的类名（不带消息，消息里可能回显凭据）。
   */
  async listTools(
    connector: string,
    endpoint: unknown,
    auth: () => Promise<AuthInjection>,
    logCtx: Record<string, unknown>,
    /** 收到 401：OAuth 应用在刷新锁内刷新（参数为最后一次注入的鉴权）。 */
    onUnauthorized: (last: AuthInjection | undefined) => Promise<void> = async () => {},
  ): Promise<{ specs: unknown; resources: boolean }> {
    const c = this.d.registry.findConnector(connector);
    if (!c) {
      throw new ApiError("app.connect_failed", `The connector ${connector} is not installed`);
    }
    const signal = AbortSignal.timeout(this.d.config().tools.timeoutMs);
    const injected: AuthInjection[] = [];
    const tracked = async () => {
      const inj = await auth();
      injected.push(inj);
      return inj;
    };
    let session: Awaited<ReturnType<typeof c.open>> | undefined;
    try {
      // 不传 onToolsChanged：本来就在拉清单
      session = await c.open({
        endpoint,
        auth: tracked,
        onUnauthorized: () => onUnauthorized(injected.at(-1)),
        signal,
      });
      const specs = await session.listTools();
      return {
        specs: redactDeep(specs, redactorFor(injected)),
        resources: typeof session.listResources === "function",
      };
    } catch (e) {
      if (e instanceof CredentialMissing) throw e;
      // 日志经 logger 打码（凭据值已在构造注入时登记）
      this.d.log.warn("app listTools failed", { ...logCtx, connector, err: e });
      throw new ApiError("app.connect_failed", connectFailedMessage(e, redactorFor(injected)));
    } finally {
      await session?.close().catch((e: unknown) => {
        this.d.log.warn("connector session close failed", { ...logCtx, connector, err: e });
      });
    }
  }

  /**
   * 把新快照与当前工具行比对并写入（调用方已在事务内锁住应用行）；返回按名排序的变化。
   * 规则见文件头。待复核的新定义也写进 `tool_specs`（内容寻址，只增不改）。
   */
  async apply(
    t: Trx,
    app: { id: string; tools_synced_at: Date | null },
    rows: SnapshotRow[],
  ): Promise<DriftChanges> {
    const current = await t
      .selectFrom("app_tools")
      .select([
        "name",
        "spec_hash",
        "source",
        "pending_spec_hash",
        "pending_source",
        "missing_since",
        "policy_source",
      ])
      .where("app_id", "=", app.id)
      .forUpdate()
      .execute();
    const initial = app.tools_synced_at === null && current.length === 0;
    const before = new Map(current.map((c) => [c.name, c]));
    const next = new Set(rows.map((r) => r.name));
    const added: string[] = [];
    const changed: string[] = [];

    await recordToolSpecs(t, rows);
    const fresh = rows.filter((r) => !before.has(r.name));
    if (fresh.length > 0) {
      await t
        .insertInto("app_tools")
        .values(
          fresh.map((r) => ({
            app_id: app.id,
            name: r.name,
            spec: JSON.stringify(r.spec),
            spec_hash: r.specHash,
            status: r.issue
              ? ("disabled" as const)
              : initial
                ? ("enabled" as const)
                : ("pending_review" as const),
            default_policy: policyFromAnnotations(r.spec.annotations),
            source: r.source,
            ...(initial && !r.issue && { reviewed_at: sql<Date>`now()` }),
          })),
        )
        .execute();
      added.push(...fresh.map((r) => r.name));
    }

    for (const r of rows) {
      const c = before.get(r.name);
      if (!c) continue;
      const sameAsReviewed = r.specHash === c.spec_hash && r.source === c.source;
      // 新定义直接成为当前定义（工具随之停用，不经复核）：管理员设的默认策略只在同一来源时保留
      const adopt = {
        spec: JSON.stringify(r.spec),
        spec_hash: r.specHash,
        source: r.source,
        pending_spec: null,
        pending_spec_hash: null,
        pending_source: null,
        ...((c.policy_source === "derived" || c.source !== r.source) && {
          default_policy: policyFromAnnotations(r.spec.annotations),
          policy_source: "derived" as const,
        }),
      };
      const pending = sameAsReviewed
        ? { pending_spec: null, pending_spec_hash: null, pending_source: null }
        : {
            pending_spec: JSON.stringify(r.spec),
            pending_spec_hash: r.specHash,
            pending_source: r.source,
          };
      let set: Record<string, unknown>;
      if (c.missing_since !== null) {
        // 消失后又出现：按新增处理（待复核）
        set = r.issue
          ? { ...adopt, status: "disabled", missing_since: null }
          : { ...pending, status: "pending_review", missing_since: null };
        added.push(r.name);
      } else {
        const latestHash = c.pending_spec_hash ?? c.spec_hash;
        const latestSource = c.pending_source ?? c.source;
        if (r.specHash === latestHash && r.source === latestSource) continue;
        set = r.issue ? { ...adopt, status: "disabled" } : { ...pending, status: "pending_review" };
        changed.push(r.name);
      }
      await t
        .updateTable("app_tools")
        .set(set)
        .where("app_id", "=", app.id)
        .where("name", "=", r.name)
        .execute();
    }

    const removed = current
      .filter((c) => !next.has(c.name) && c.missing_since === null)
      .map((c) => c.name);
    if (removed.length > 0) {
      await t
        .updateTable("app_tools")
        .set({
          status: "disabled",
          missing_since: sql<Date>`now()`,
          pending_spec: null,
          pending_spec_hash: null,
          pending_source: null,
        })
        .where("app_id", "=", app.id)
        .where("name", "in", removed)
        .execute();
    }

    const any = added.length + changed.length + removed.length > 0;
    await t
      .updateTable("apps")
      .set({ tools_synced_at: sql<Date>`now()`, ...(any && { updated_at: sql<Date>`now()` }) })
      .where("id", "=", app.id)
      .execute();
    return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
  }

  /**
   * 后台检查一个应用（维护队列的 worker 上执行，没有发起人）：拉工具清单 → 比对写入 → 有变化记审计
   * `app.tools_drifted`（detail 只有新增 / 变化 / 消失的个数与触发方式，不含定义与凭据）。
   * 凭据：无需凭据 / 组织凭据型（含客户端凭据流）用组织凭据；个人凭据型（静态或 OAuth 授权码）依次尝试
   * 至多 {@link PERSONAL_CANDIDATES} 个**现任成员**的个人凭据，按凭据最近写入时间倒序（连接 / 刷新 token
   * 都会更新写入时间，即「最近连接成功的成员」优先），用第一个成功的；没有任何成员凭据 → 跳过并记日志。
   * 连不上 / 都失败 → 跳过（不改快照，下个周期或下次通知再查）。
   */
  async check(orgId: string, appId: string, trigger: DriftTrigger): Promise<DriftCheckResult> {
    const { db, log } = this.d;
    const app = (await db
      .selectFrom("apps")
      .select([
        "id",
        "org_id",
        "slug",
        "connector",
        "endpoint",
        "auth",
        "status",
        "created_by",
        "tools_synced_at",
      ])
      .where("id", "=", appId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst()) as AppRow | undefined;
    if (!app) return { status: "skipped", reason: "not_found" };
    if (app.status !== "active") return { status: "skipped", reason: "inactive" };
    if (!this.d.registry.findConnector(app.connector)) {
      log.warn("tool drift check skipped: connector not installed", {
        orgId,
        appId,
        connector: app.connector,
      });
      return { status: "skipped", reason: "no_connector" };
    }
    const auth = app.auth as AppAuth;
    const personal = auth.type !== "none" && !isOAuth(auth) && auth.ownership === "personal";
    const personalOAuth = auth.type === "oauth_code";
    const accounts =
      personal || personalOAuth
        ? await this.d.credentials.personalHolders(orgId, appId, PERSONAL_CANDIDATES)
        : [app.created_by];
    if (accounts.length === 0) {
      log.info("tool drift check skipped: no member credential", { orgId, appId });
      return { status: "skipped", reason: "no_credential" };
    }

    let listed: { specs: unknown; resources: boolean } | undefined;
    let reason: "no_credential" | "connect_failed" = "no_credential";
    for (const accountId of accounts) {
      try {
        listed = await this.listTools(
          app.connector,
          app.endpoint,
          () => this.d.credentials.injection(orgId, appId, auth, accountId),
          { orgId, appId, trigger },
          (last) => this.d.credentials.onUnauthorized(orgId, appId, auth, accountId, last),
        );
        break;
      } catch (e) {
        if (e instanceof CredentialMissing) continue;
        if (e instanceof ApiError) {
          reason = "connect_failed";
          continue;
        }
        throw e;
      }
    }
    if (!listed) {
      log.warn("tool drift check skipped: could not list tools", { orgId, appId, reason });
      return { status: "skipped", reason };
    }
    const { rows } = snapshot(app.slug, listed.specs, listed.resources);

    const changes = await db.transaction().execute(async (t) => {
      const locked = await t
        .selectFrom("apps")
        .select(["id", "tools_synced_at"])
        .where("id", "=", appId)
        .where("deleted_at", "is", null)
        .where("status", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (!locked) return null;
      const c = await this.apply(t, locked, rows);
      if (c.added.length + c.changed.length + c.removed.length > 0) {
        await audit(t, {
          orgId,
          action: "app.tools_drifted",
          target: appId,
          detail: {
            added: c.added.length,
            changed: c.changed.length,
            removed: c.removed.length,
            trigger,
          },
        });
      }
      return c;
    });
    if (!changes) return { status: "skipped", reason: "inactive" };
    return { status: "checked", changes };
  }

  /**
   * 连接器在会话中报告工具清单变了：投递一次该应用的检查（jobId 按分钟桶去重）。投递失败只记日志。
   */
  async onToolsChanged(orgId: string, appId: string): Promise<void> {
    const m = this.d.maintenance;
    if (!m || appId.includes(":")) return;
    try {
      await m.add(
        DRIFT_APP_JOB,
        { orgId, appId, trigger: "list_changed" },
        {
          jobId: listChangedJobId(appId),
          removeOnComplete: { age: 3_600 },
          removeOnFail: KEEP_FAILED,
        },
      );
    } catch (err) {
      this.d.log.warn("cannot enqueue tool drift check", { orgId, appId, err });
    }
  }

  /**
   * 周期扫描：给本周期内还没检查过的活动应用（`tools_synced_at` 为空或早于半个周期）各投递一次检查，
   * jobId 按周期桶去重——即使扫描在多个副本上重复执行，每个应用每周期也只检查一次。返回投递数。
   */
  async scan(): Promise<number> {
    const m = this.d.maintenance;
    if (!m) return 0;
    const interval = this.intervalMs();
    const bucket = Math.floor(Date.now() / interval);
    const apps = await this.d.db
      .selectFrom("apps")
      .select(["id", "org_id"])
      .where("deleted_at", "is", null)
      .where("status", "=", "active")
      .where((eb) =>
        eb.or([
          eb("tools_synced_at", "is", null),
          eb(
            "tools_synced_at",
            "<",
            sql<Date>`now() - ${Math.floor(interval / 2)}::bigint * interval '1 millisecond'`,
          ),
        ]),
      )
      .orderBy("id")
      .execute();
    for (const a of apps) {
      if (a.id.includes(":")) continue;
      await m.add(
        DRIFT_APP_JOB,
        { orgId: a.org_id, appId: a.id, trigger: "schedule" },
        {
          jobId: driftScanJobId(a.id, bucket),
          removeOnComplete: { age: Math.ceil(interval / 1000) },
          removeOnFail: KEEP_FAILED,
        },
      );
    }
    return apps.length;
  }
}
