import { randomUUID } from "node:crypto";
import type { AuthInjection, Logger, ToolAnnotations, ToolSpec } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import type { PluginHost } from "../plugins/host.js";
import {
  type AppAuth,
  CredentialMissing,
  type CredentialOwner,
  type Credentials,
  type StaticSecret,
} from "./credentials.js";
import { deriveSlug, isValidSlug, SLUG_RULE, toolKey, toolKeyIssue } from "./naming.js";
import { redactDeep, redactorFor } from "./redact.js";
import { policyFromAnnotations, specHash, type ToolPolicy, type ToolRegistry } from "./registry.js";
import { resourceToolSpecs } from "./resources.js";

type Trx = Transaction<KernelDatabase>;
type ToolStatus = "enabled" | "disabled" | "pending_review";
type ToolSource = "connector" | "resources";

/** 应用工具视图；`issue` 非空表示该工具不能启用的原因（如 key 超长）。 */
export interface AppToolView {
  name: string;
  key: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations | null;
  status: ToolStatus;
  defaultPolicy: ToolPolicy;
  specHash: string;
  issue: string | null;
  /** `resources`：内核为支持 resources 的应用补上的工具（见 resources.ts）。 */
  source: ToolSource;
}

/** 列表项：不含工具与凭据（`auth` 只有类型与非密钥字段）。 */
export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: unknown;
  auth: AppAuth;
  status: "active" | "disabled";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppDetail extends AppSummary {
  tools: AppToolView[];
  /** 当前用户视角的凭据状态；`ownership` 为 null 表示无需凭据（auth none）。 */
  credential: { ownership: "org" | "personal" | null; status: "connected" | "missing" };
}

/** 快照中被停用 / 跳过的工具及英文原因。 */
export interface ToolIssue {
  name: string;
  reason: string;
}

export interface CreateAppInput {
  name: string;
  slug?: string | undefined;
  connector: string;
  endpoint: unknown;
  auth: AppAuth;
  credential?: unknown;
}

export interface UpdateAppInput {
  name?: string | undefined;
  status?: "active" | "disabled" | undefined;
  tools?:
    | Record<
        string,
        { status?: "enabled" | "disabled" | undefined; defaultPolicy?: ToolPolicy | undefined }
      >
    | undefined;
  /** 把「没有 readOnlyHint / destructiveHint 注解」的工具默认策略批量改为 allow。 */
  allowUnannotated?: boolean | undefined;
}

interface SnapshotRow {
  name: string;
  spec: ToolSpec;
  specHash: string;
  /** key 不合法 / 定义不合规时为原因，此时工具只能停用。 */
  issue: string | null;
  source: ToolSource;
}

const notFound = () => new ApiError("app.not_found", "App not found");

const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

const errName = (e: unknown): string =>
  e instanceof Error && typeof e.name === "string" && e.name !== "" ? e.name : "Error";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 无注解 = 既没有 readOnlyHint 也没有 destructiveHint。 */
const unannotated = (a: ToolAnnotations | undefined) =>
  a?.readOnlyHint === undefined && a?.destructiveHint === undefined;

/**
 * 把连接器返回的工具清单整理成快照：只保留 `name / description / inputSchema / annotations`
 * （应用工具不得自带 `defaultPolicy`），同名的后者丢弃；key 超长 / 含非法字符或定义不合规的工具
 * 照样入库但只能停用，并给出原因——一个坏工具不挡住整个应用。名字不是非空字符串的无法入库，只报原因。
 */
function snapshot(
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

/** 工具当前不能启用的原因（视图与启用校验共用）。 */
function toolIssue(slug: string, spec: ToolSpec): string | null {
  const keyIssue = toolKeyIssue(toolKey(slug, spec.name));
  if (keyIssue) return keyIssue;
  if (!isObj(spec.inputSchema)) return "Tool inputSchema must be an object";
  return null;
}

/**
 * 应用（已安装的连接器实例）与其工具快照、凭据。写操作都在组织行锁内复核发起人权限并写审计
 * （detail 只有凭据类型与归属，没有值）。连接器会话按操作打开、用完即关，不在进程内缓存。
 */
export class AppsService {
  constructor(
    private readonly db: KernelDb,
    private readonly registry: ToolRegistry,
    private readonly host: PluginHost,
    private readonly credentials: Credentials,
    private readonly config: () => KernelConfig,
    private readonly log: Logger,
  ) {}

  /** 校验连接器存在、端点按其 schema 合法；返回解析后的端点。 */
  private parseEndpoint(connector: string, endpoint: unknown): unknown {
    const c = this.registry.findConnector(connector);
    if (!c) {
      const kinds = this.registry.connectorKinds();
      throw fail(
        "connector",
        `Unknown connector "${connector}"; installed connectors: ${kinds.length > 0 ? kinds.join(", ") : "none"}`,
      );
    }
    const r = c.endpointSchema.safeParse(endpoint);
    if (!r.success) {
      throw new ApiError(
        "validation_failed",
        "Request validation failed",
        r.error.issues.map((i: { path: PropertyKey[]; message: string }) => ({
          path: ["endpoint", ...i.path.map(String)].join("."),
          message: i.message,
        })),
      );
    }
    return r.data;
  }

  /**
   * 打开一次会话拉工具清单，无论成败都关闭会话；会话带 `listResources` 即视为支持 resources。
   * 清单里回显的凭据按本次注入的值打码（见 redact.ts）。凭据缺失原样抛 `credential.missing`；
   * 其余失败一律 502 `app.connect_failed`，消息只带上游错误的类名（不带消息，消息里可能回显凭据）。
   */
  private async listTools(
    connector: string,
    endpoint: unknown,
    auth: () => Promise<AuthInjection>,
    logCtx: Record<string, unknown>,
  ): Promise<{ specs: unknown; resources: boolean }> {
    const c = this.registry.connector(connector);
    const signal = AbortSignal.timeout(this.config().tools.timeoutMs);
    const injected: AuthInjection[] = [];
    const tracked = async () => {
      const inj = await auth();
      injected.push(inj);
      return inj;
    };
    let session: Awaited<ReturnType<typeof c.open>> | undefined;
    try {
      session = await c.open({ endpoint, auth: tracked, onUnauthorized: async () => {}, signal });
      const specs = await session.listTools();
      return {
        specs: redactDeep(specs, redactorFor(injected)),
        resources: typeof session.listResources === "function",
      };
    } catch (e) {
      if (e instanceof CredentialMissing) throw e;
      // 日志经 logger 打码（凭据值已在构造注入时登记）
      this.log.warn("app listTools failed", { ...logCtx, connector, err: e });
      throw new ApiError("app.connect_failed", `Could not list tools from the app (${errName(e)})`);
    } finally {
      await session?.close().catch((e: unknown) => {
        this.log.warn("connector session close failed", { ...logCtx, connector, err: e });
      });
    }
  }

  private async slugTaken(db: KernelDb | Trx, orgId: string, slug: string): Promise<boolean> {
    const row = await db
      .selectFrom("apps")
      .select("id")
      .where("org_id", "=", orgId)
      .where("slug", "=", slug)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row !== undefined;
  }

  private resolveSlug(input: CreateAppInput): string {
    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) throw fail("slug", SLUG_RULE);
      return input.slug;
    }
    const derived = deriveSlug(input.name);
    if (!derived) {
      throw fail("slug", `Cannot derive a slug from the name; provide one. ${SLUG_RULE}`);
    }
    return derived;
  }

  /**
   * 安装应用（A4）：校验 → 用请求里的凭据（尚未落库）连接并 listTools → 一个事务内写应用、工具快照、
   * 凭据与审计。连接失败时什么都不写。组织凭据型应用的 `credential` 是组织凭据，个人型是创建者自己的。
   */
  async create(
    orgId: string,
    actorAccountId: string,
    input: CreateAppInput,
    actorTokenId?: string,
  ): Promise<{ app: AppDetail; issues: ToolIssue[] }> {
    const slug = this.resolveSlug(input);
    const endpoint = this.parseEndpoint(input.connector, input.endpoint);
    if (this.host.manifests().some((m) => m.name === slug)) {
      throw fail("slug", `Slug "${slug}" is the name of an installed plugin; choose another`);
    }
    const id = randomUUID();
    const auth = input.auth;
    let owner: CredentialOwner | undefined;
    let secret: StaticSecret | undefined;
    if (input.credential !== undefined && input.credential !== null) {
      if (auth.type === "none") throw fail("credential", "Auth type none takes no credential");
      owner =
        auth.ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
      this.credentials.validate(auth, owner, input.credential);
      secret = input.credential;
    }
    // 先做不需要连接的检查：冲突的 slug 不该触发一次外连
    if (await this.slugTaken(this.db, orgId, slug)) {
      throw new ApiError("app.slug_taken", "App slug is already taken");
    }
    const { specs, resources } = await this.listTools(
      input.connector,
      endpoint,
      async () => {
        if (auth.type === "none") return { headers: {} };
        if (!secret) throw new CredentialMissing(id, auth.ownership);
        return this.credentials.injectionFor(id, auth, secret);
      },
      { orgId, slug },
    );
    const { rows, issues } = snapshot(slug, specs, resources);

    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      if (await this.slugTaken(t, orgId, slug)) {
        throw new ApiError("app.slug_taken", "App slug is already taken");
      }
      await t
        .insertInto("apps")
        .values({
          id,
          org_id: orgId,
          slug,
          name: input.name,
          connector: input.connector,
          endpoint: JSON.stringify(endpoint),
          auth: JSON.stringify(auth),
          created_by: actorAccountId,
        })
        .execute();
      await this.insertTools(t, id, rows);
      if (secret && owner) await this.credentials.setStatic(orgId, id, auth, owner, secret, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.created",
        target: id,
        detail: {
          slug,
          connector: input.connector,
          auth: { type: auth.type, ...(auth.type !== "none" && { ownership: auth.ownership }) },
          tools: rows.length,
          credentialProvided: secret !== undefined,
        },
      });
      return { app: await this.detail(t, orgId, id, actorAccountId), issues };
    });
  }

  private async insertTools(t: Trx, appId: string, rows: SnapshotRow[]): Promise<void> {
    if (rows.length === 0) return;
    await t
      .insertInto("app_tools")
      .values(
        rows.map((r) => ({
          app_id: appId,
          name: r.name,
          spec: JSON.stringify(r.spec),
          spec_hash: r.specHash,
          status: r.issue ? ("disabled" as const) : ("enabled" as const),
          default_policy: policyFromAnnotations(r.spec.annotations),
          source: r.source,
        })),
      )
      .execute();
  }

  /** 读本组织未删除的应用行；不存在 → `app.not_found`。`lock` 时 FOR UPDATE。 */
  private async row(db: KernelDb | Trx, orgId: string, appId: string, lock = false) {
    let q = db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", appId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw notFound();
    return r;
  }

  private summary(r: Awaited<ReturnType<AppsService["row"]>>): AppSummary {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      connector: r.connector,
      endpoint: r.endpoint,
      auth: r.auth as unknown as AppAuth,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async detail(
    db: KernelDb | Trx,
    orgId: string,
    appId: string,
    viewerAccountId: string,
  ): Promise<AppDetail> {
    const r = await this.row(db, orgId, appId);
    const tools = await db
      .selectFrom("app_tools")
      .select(["name", "spec", "spec_hash", "status", "default_policy", "source"])
      .where("app_id", "=", appId)
      .orderBy("name")
      .execute();
    const s = this.summary(r);
    const auth = s.auth;
    const status = await this.credentials.status(
      orgId,
      appId,
      auth,
      viewerAccountId,
      db === this.db ? undefined : (db as Trx),
    );
    return {
      ...s,
      tools: tools.map((t) => {
        const spec = t.spec as ToolSpec;
        return {
          name: t.name,
          key: toolKey(r.slug, t.name),
          description: spec.description,
          inputSchema: spec.inputSchema,
          annotations: spec.annotations ?? null,
          status: t.status,
          defaultPolicy: t.default_policy,
          specHash: t.spec_hash,
          issue: toolIssue(r.slug, spec),
          source: t.source,
        };
      }),
      credential: { ownership: auth.type === "none" ? null : auth.ownership, status },
    };
  }

  /** 本组织未删除的应用（按创建时间）。 */
  async list(orgId: string): Promise<AppSummary[]> {
    const rows = await this.db
      .selectFrom("apps")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((r) => this.summary(r));
  }

  async get(orgId: string, appId: string, viewerAccountId: string): Promise<AppDetail> {
    return this.detail(this.db, orgId, appId, viewerAccountId);
  }

  /** 改名、启停应用、工具启停与默认策略、批量把无注解工具改为 allow（`apps.manage`）。 */
  async update(
    orgId: string,
    appId: string,
    actorAccountId: string,
    patch: UpdateAppInput,
    actorTokenId?: string,
  ): Promise<AppDetail> {
    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      const app = await this.row(t, orgId, appId, true);
      const current = await t
        .selectFrom("app_tools")
        .select(["name", "spec", "status", "default_policy"])
        .where("app_id", "=", appId)
        .forUpdate()
        .execute();
      const byName = new Map(current.map((c) => [c.name, c]));
      const toolChanges = Object.entries(patch.tools ?? {});
      const problems: { path: string; message: string }[] = [];
      for (const [name, change] of toolChanges) {
        const c = byName.get(name);
        if (!c) {
          problems.push({ path: `tools.${name}`, message: "No such tool in this app" });
          continue;
        }
        if (change.status === "enabled") {
          const issue = toolIssue(app.slug, c.spec as ToolSpec);
          if (issue) problems.push({ path: `tools.${name}.status`, message: issue });
        }
      }
      if (problems.length > 0) {
        throw new ApiError("validation_failed", "Request validation failed", problems);
      }

      if (patch.name !== undefined || patch.status !== undefined) {
        await t
          .updateTable("apps")
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.status !== undefined && { status: patch.status }),
            updated_at: sql`now()`,
          })
          .where("id", "=", appId)
          .execute();
      }
      const allowed: string[] = [];
      if (patch.allowUnannotated) {
        for (const c of current) {
          const explicit = patch.tools?.[c.name]?.defaultPolicy !== undefined;
          if (
            !explicit &&
            c.default_policy === "ask" &&
            unannotated((c.spec as ToolSpec).annotations)
          ) {
            allowed.push(c.name);
          }
        }
        if (allowed.length > 0) {
          await t
            .updateTable("app_tools")
            .set({ default_policy: "allow" })
            .where("app_id", "=", appId)
            .where("name", "in", allowed)
            .execute();
        }
      }
      for (const [name, change] of toolChanges) {
        if (change.status === undefined && change.defaultPolicy === undefined) continue;
        await t
          .updateTable("app_tools")
          .set({
            ...(change.status !== undefined && { status: change.status }),
            // 启用即视为已复核（第二段的漂移复核沿用这一字段）
            ...(change.status === "enabled" && { reviewed_at: sql`now()` }),
            ...(change.defaultPolicy !== undefined && { default_policy: change.defaultPolicy }),
          })
          .where("app_id", "=", appId)
          .where("name", "=", name)
          .execute();
      }
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.updated",
        target: appId,
        detail: {
          ...(patch.name !== undefined && { name: { from: app.name, to: patch.name } }),
          ...(patch.status !== undefined && { status: { from: app.status, to: patch.status } }),
          ...(toolChanges.length > 0 && { tools: Object.fromEntries(toolChanges) }),
          ...(allowed.length > 0 && { allowedUnannotated: allowed }),
        },
      });
      return this.detail(t, orgId, appId, actorAccountId);
    });
  }

  /** 软删除，并删除该应用的全部凭据（`apps.manage`）。 */
  async remove(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      const app = await this.row(t, orgId, appId, true);
      await t
        .updateTable("apps")
        .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", appId)
        .execute();
      await this.credentials.clearApp(orgId, appId, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.deleted",
        target: appId,
        detail: { slug: app.slug },
      });
    });
  }

  /**
   * 重新 listTools 并直接覆盖快照（第一段；第二段改走漂移检测）：已有工具更新定义、保留管理员设的启停与默认策略
   * （key 变得不合法的强制停用），新工具按注解推导默认值并启用，消失的工具删除。
   * 组织凭据型应用用组织凭据，个人型用发起人自己的凭据（缺 → `credential.missing`）。
   */
  async refresh(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<{
    app: AppDetail;
    issues: ToolIssue[];
    changes: { added: string[]; removed: string[]; changed: string[] };
  }> {
    const app = await this.row(this.db, orgId, appId);
    const auth = app.auth as unknown as AppAuth;
    const { specs, resources } = await this.listTools(
      app.connector,
      app.endpoint,
      () => this.credentials.injection(orgId, appId, auth, actorAccountId),
      { orgId, appId },
    );
    const { rows, issues } = snapshot(app.slug, specs, resources);

    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      await this.row(t, orgId, appId, true);
      const current = await t
        .selectFrom("app_tools")
        .select(["name", "spec_hash", "source"])
        .where("app_id", "=", appId)
        .forUpdate()
        .execute();
      const before = new Map(current.map((c) => [c.name, c]));
      const next = new Set(rows.map((r) => r.name));
      const added = rows.filter((r) => !before.has(r.name));
      const changed = rows.filter((r) => {
        const b = before.get(r.name);
        return b !== undefined && (b.spec_hash !== r.specHash || b.source !== r.source);
      });
      const removed = current.filter((c) => !next.has(c.name)).map((c) => c.name);

      await this.insertTools(t, appId, added);
      for (const r of changed) {
        await t
          .updateTable("app_tools")
          .set({
            spec: JSON.stringify(r.spec),
            spec_hash: r.specHash,
            source: r.source,
            // 来源变了（内核的 resources 工具 ↔ 连接器同名工具）就是另一个工具：管理员为旧工具设的默认策略不沿用，
            // 按新定义的注解重新推导（否则连接器的无注解工具会继承 resources 工具的 allow）
            ...(before.get(r.name)?.source !== r.source && {
              default_policy: policyFromAnnotations(r.spec.annotations),
            }),
            ...(r.issue && { status: "disabled" as const }),
          })
          .where("app_id", "=", appId)
          .where("name", "=", r.name)
          .execute();
      }
      if (removed.length > 0) {
        await t
          .deleteFrom("app_tools")
          .where("app_id", "=", appId)
          .where("name", "in", removed)
          .execute();
      }
      await t.updateTable("apps").set({ updated_at: sql`now()` }).where("id", "=", appId).execute();
      const changes = {
        added: added.map((r) => r.name).sort(),
        removed: removed.sort(),
        changed: changed.map((r) => r.name).sort(),
      };
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.tools_refreshed",
        target: appId,
        detail: changes,
      });
      return { app: await this.detail(t, orgId, appId, actorAccountId), issues, changes };
    });
  }

  /**
   * 写凭据（组织凭据：`apps.manage`；个人凭据：`apps.use`，只写发起人自己的那一条）。
   * 形状与归属不符 → `validation_failed`。审计只记类型与归属。
   */
  async setCredential(
    orgId: string,
    appId: string,
    actorAccountId: string,
    ownership: "org" | "personal",
    value: unknown,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        ownership === "org" ? "apps.manage" : "apps.use",
      );
      const app = await this.row(t, orgId, appId);
      const auth = app.auth as unknown as AppAuth;
      const owner: CredentialOwner =
        ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
      this.credentials.validate(auth, owner, value);
      await this.credentials.setStatic(orgId, appId, auth, owner, value, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.credential.set",
        target: appId,
        detail: { type: auth.type, ownership },
      });
    });
  }

  /** 删除发起人自己的个人凭据（`apps.use`）；本来就没有也成功。 */
  async clearMyCredential(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.use");
      const app = await this.row(t, orgId, appId);
      await this.credentials.clear(orgId, appId, { kind: "user", accountId: actorAccountId }, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.credential.cleared",
        target: appId,
        detail: { type: (app.auth as unknown as AppAuth).type, ownership: "personal" },
      });
    });
  }
}
