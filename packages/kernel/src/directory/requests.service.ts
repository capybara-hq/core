import { randomUUID } from "node:crypto";
import type { LocalizedName, PackageKind } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";

type Trx = Transaction<KernelDatabase>;

export type DirectoryRequestStage = "org" | "deployment";
export type DirectoryRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type DirectoryDecision = "approve" | "reject";

/** 一条目录申请（收件箱 `directory_request`、企业管理员申请列表）。 */
export interface DirectoryRequestView {
  id: string;
  orgId: string;
  orgName: string;
  item: { id: string; kind: PackageKind; name: string; displayName: LocalizedName | null };
  version: string | null;
  stage: DirectoryRequestStage;
  status: DirectoryRequestStatus;
  note: string;
  requestedBy: string | null;
  /** 申请人的显示名（账号已删除为 null）。 */
  requestedByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** 组织管理员批准并升级到企业管理员时的批准人与时间（没有升级为 null）。 */
  orgDecidedBy: string | null;
  orgDecidedAt: string | null;
  createdAt: string;
}

/** 申请列表一次最多返回的条数。 */
export const DIRECTORY_REQUESTS_LIST_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestNotFound = () =>
  new ApiError("directory.request_not_found", "Directory request not found");
const itemNotFound = () => new ApiError("directory.item_not_found", "Directory item not found");
const itemDisabled = () =>
  new ApiError(
    "directory.item_disabled",
    "This directory item is disabled by the enterprise admin and cannot be newly installed",
  );

/** 在调用方事务里读条目的策略（FOR SHARE：与企业管理员改策略 / 删除互斥）。不存在或已删除 → undefined。 */
async function lockItem(t: Trx, itemId: string) {
  if (!UUID_RE.test(itemId)) return undefined;
  return t
    .selectFrom("directory_items")
    .select(["id", "kind", "name", "policy", "deleted_at"])
    .where("id", "=", itemId)
    .forShare()
    .executeTakeFirst();
}

async function hasGrant(db: KernelDb | Trx, orgId: string, itemId: string): Promise<boolean> {
  const g = await db
    .selectFrom("directory_org_grants")
    .select("item_id")
    .where("item_id", "=", itemId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return g !== undefined;
}

/**
 * 组织新建来自目录的组件（启用插件、按模板建连接器、导入技能）前，在调用方事务里复核条目策略（C22）：
 * 已删除或 disabled → `directory.item_disabled`；needs_approval 且企业管理员没有给本组织授予 →
 * `directory.approval_required`；allow 或已授予 → 通过。应用的组件按应用条目判定（调用方传应用条目 id）。
 */
export async function assertItemInstallable(t: Trx, orgId: string, itemId: string): Promise<void> {
  const item = await lockItem(t, itemId);
  if (!item || item.deleted_at !== null || item.policy === "disabled") throw itemDisabled();
  if (item.policy === "needs_approval" && !(await hasGrant(t, orgId, itemId))) {
    throw new ApiError(
      "directory.approval_required",
      "This directory item needs enterprise admin approval before this organization can install it",
    );
  }
}

/**
 * 组织直接启用插件（不经某个条目安装，如 `PUT /orgs/:orgId/plugins/:plugin`）时，按把它带进部署的全部目录条目
 * （`plugin_directory_sources`）判定，**最严格的生效**：任一来源 disabled → `directory.item_disabled`；否则任一来源
 * needs_approval 且本组织没有该条目的授予 → `directory.approval_required`；全部 allow / 已授予 → 通过。已删除的条目不再
 * 算来源（企业管理员删掉条目即撤回它的约束）。没有来源（不经目录安装）→ 不受目录策略约束。
 */
export async function assertPluginSourcesInstallable(
  t: Trx,
  orgId: string,
  plugin: string,
): Promise<void> {
  const rows = await t
    .selectFrom("plugin_directory_sources as s")
    .innerJoin("directory_items as i", "i.id", "s.item_id")
    .select(["i.id", "i.policy"])
    .where("s.plugin", "=", plugin)
    .where("i.deleted_at", "is", null)
    .orderBy("i.id")
    .forShare("i")
    .execute();
  if (rows.some((r) => r.policy === "disabled")) throw itemDisabled();
  for (const r of rows) {
    if (r.policy === "needs_approval" && !(await hasGrant(t, orgId, r.id))) {
      throw new ApiError(
        "directory.approval_required",
        "A directory item that brought this plugin in needs enterprise admin approval before this organization can enable it",
      );
    }
  }
}

/** 审计里带上 PAT（个人令牌发起时）。 */
export interface RequestActorOpts {
  actorTokenId?: string;
}

/**
 * 目录申请与审批（C22 / F-AF）。两级：
 * - 成员申请（stage `org`）进组织管理员收件箱，组织管理员（`directory.decide`）批准或拒绝；条目是 needs_approval 且本组织
 *   没有授予时，批准把申请升级到 stage `deployment`（仍 pending），交企业管理员决定；
 * - 组织管理员安装 needs_approval 且未授予的条目 → 建（或把已有的 pending 申请升级为）stage `deployment` 的申请；
 * - 企业管理员批准 stage `deployment` 的申请 → 写授予（`directory_org_grants`，跨版本有效），之后组织管理员可以安装。
 * 同一组织、同一条目只能有一个 pending 申请（部分唯一索引；组织侧写操作都在组织行锁内，按序执行）。
 * 无进程内状态。
 */
export class DirectoryRequestsService {
  constructor(private readonly db: KernelDb) {}

  /**
   * 成员申请（`directory.request`，组织行锁内复核）。条目不存在 / 已删除 → `directory.item_not_found`；disabled →
   * `directory.item_disabled`。已有 pending 申请时直接返回它（`created: false`），不另建。审计 `directory.requested`。
   */
  async request(
    orgId: string,
    actor: string,
    itemId: string,
    input: { note?: string | undefined; version?: string | undefined },
    opts: RequestActorOpts = {},
  ): Promise<{ request: DirectoryRequestView; created: boolean }> {
    const r = await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actor, "directory.request");
      const item = await lockItem(t, itemId);
      if (!item || item.deleted_at !== null) throw itemNotFound();
      if (item.policy === "disabled") throw itemDisabled();
      const existing = await this.pendingRow(t, orgId, itemId);
      if (existing) return { id: existing.id, created: false };
      const id = randomUUID();
      await t
        .insertInto("directory_requests")
        .values({
          id,
          org_id: orgId,
          item_id: itemId,
          version: input.version ?? null,
          stage: "org",
          requested_by: actor,
          note: input.note ?? "",
        })
        .execute();
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "directory.requested",
        target: id,
        detail: { itemId, kind: item.kind, name: item.name, stage: "org" },
      });
      return { id, created: true };
    });
    return { request: await this.view(this.db, r.id), created: r.created };
  }

  private pendingRow(t: Trx | KernelDb, orgId: string, itemId: string) {
    return t
      .selectFrom("directory_requests")
      .select(["id", "stage"])
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("status", "=", "pending")
      .executeTakeFirst();
  }

  /**
   * 组织管理员安装 needs_approval 且未授予的条目：在调用方事务里（调用方已锁组织行并复核角色）建 stage `deployment`
   * 的申请；已有 pending 申请时把它升级为 deployment（成员申请随之交企业管理员）。返回申请 id。审计 `directory.requested`。
   */
  async requestDeployment(
    t: Trx,
    orgId: string,
    actor: string,
    item: { id: string; kind: PackageKind; name: string },
    version: string | null,
    opts: RequestActorOpts = {},
  ): Promise<string> {
    const existing = await this.pendingRow(t, orgId, item.id);
    if (existing) {
      if (existing.stage === "org") {
        await t
          .updateTable("directory_requests")
          .set({ stage: "deployment", org_decided_by: actor, org_decided_at: sql<Date>`now()` })
          .where("id", "=", existing.id)
          .execute();
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "directory.request_decided",
          target: existing.id,
          detail: { itemId: item.id, decision: "approve", stage: "org", escalated: true },
        });
      }
      return existing.id;
    }
    const id = randomUUID();
    await t
      .insertInto("directory_requests")
      .values({
        id,
        org_id: orgId,
        item_id: item.id,
        version,
        stage: "deployment",
        requested_by: actor,
      })
      .execute();
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "directory.requested",
      target: id,
      detail: { itemId: item.id, kind: item.kind, name: item.name, stage: "deployment" },
    });
    return id;
  }

  /**
   * 安装成功后：本组织该条目仍 pending 的成员申请（stage org）标为 approved（安装者即决定人），收件箱随之清空。
   * 在调用方事务里执行。
   */
  async resolveByInstall(
    t: Trx,
    orgId: string,
    itemId: string,
    actor: string,
    opts: RequestActorOpts = {},
  ): Promise<void> {
    const rows = await t
      .updateTable("directory_requests")
      .set({ status: "approved", decided_by: actor, decided_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("status", "=", "pending")
      .where("stage", "=", "org")
      .returning("id")
      .execute();
    for (const r of rows) {
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "directory.request_decided",
        target: r.id,
        detail: { itemId, decision: "approve", stage: "org", installed: true },
      });
    }
  }

  /**
   * 组织管理员决定成员申请（`directory.decide`，组织行锁内复核；申请行 FOR UPDATE）。不是本组织的申请 →
   * `directory.request_not_found`；已决定或已交企业管理员 → `directory.request_decided`。批准时：条目已删除或 disabled →
   * `directory.item_disabled`；needs_approval 且未授予 → 升级到 stage deployment（仍 pending）；否则 approved。
   * 审计 `directory.request_decided`。
   */
  async decideOrg(
    orgId: string,
    actor: string,
    requestId: string,
    decision: DirectoryDecision,
    opts: RequestActorOpts = {},
  ): Promise<DirectoryRequestView> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actor, "directory.decide");
      const row = await t
        .selectFrom("directory_requests")
        .select(["id", "item_id", "stage", "status"])
        .where("id", "=", requestId)
        .where("org_id", "=", orgId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw requestNotFound();
      if (row.status !== "pending" || row.stage !== "org") {
        throw new ApiError(
          "directory.request_decided",
          row.status === "pending"
            ? "This request is waiting for the enterprise admin"
            : "This request has already been decided",
        );
      }
      let escalated = false;
      if (decision === "approve") {
        const item = await lockItem(t, row.item_id);
        if (!item || item.deleted_at !== null || item.policy === "disabled") throw itemDisabled();
        escalated = item.policy === "needs_approval" && !(await hasGrant(t, orgId, row.item_id));
      }
      await t
        .updateTable("directory_requests")
        .set(
          escalated
            ? { stage: "deployment", org_decided_by: actor, org_decided_at: sql<Date>`now()` }
            : {
                status: decision === "approve" ? "approved" : "rejected",
                decided_by: actor,
                decided_at: sql<Date>`now()`,
              },
        )
        .where("id", "=", requestId)
        .execute();
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "directory.request_decided",
        target: requestId,
        detail: { itemId: row.item_id, decision, stage: "org", escalated },
      });
    });
    return this.view(this.db, requestId);
  }

  /**
   * 企业管理员决定 stage deployment 的申请（企业管理员锁内复核；申请行 FOR UPDATE）。不存在或仍在组织阶段 →
   * `directory.request_not_found`；已决定 → `directory.request_decided`。批准写授予 `directory_org_grants`。
   * 审计 `directory.request_decided`（带 orgId）。
   */
  async decideDeployment(
    actor: string,
    requestId: string,
    decision: DirectoryDecision,
    opts: RequestActorOpts = {},
  ): Promise<DirectoryRequestView> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    await this.db.transaction().execute(async (t) => {
      await lockEnterpriseAdminsAndAuthorize(t, actor);
      const row = await t
        .selectFrom("directory_requests")
        .select(["id", "org_id", "item_id", "stage", "status"])
        .where("id", "=", requestId)
        .forUpdate()
        .executeTakeFirst();
      if (row?.stage !== "deployment") throw requestNotFound();
      if (row.status !== "pending") {
        throw new ApiError("directory.request_decided", "This request has already been decided");
      }
      if (decision === "approve") {
        await t
          .insertInto("directory_org_grants")
          .values({ item_id: row.item_id, org_id: row.org_id, granted_by: actor })
          .onConflict((oc) => oc.columns(["item_id", "org_id"]).doNothing())
          .execute();
      }
      await t
        .updateTable("directory_requests")
        .set({
          status: decision === "approve" ? "approved" : "rejected",
          decided_by: actor,
          decided_at: sql<Date>`now()`,
        })
        .where("id", "=", requestId)
        .execute();
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId: row.org_id,
        action: "directory.request_decided",
        target: requestId,
        detail: { itemId: row.item_id, decision, stage: "deployment" },
      });
    });
    return this.view(this.db, requestId);
  }

  /** 企业管理员的申请列表（stage deployment；`status` 缺省 pending），新的在前。 */
  async listDeployment(
    q: { status?: DirectoryRequestStatus } = {},
  ): Promise<DirectoryRequestView[]> {
    const rows = await this.baseQuery(this.db)
      .where("r.stage", "=", "deployment")
      .where("r.status", "=", q.status ?? "pending")
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(DIRECTORY_REQUESTS_LIST_MAX)
      .execute();
    return rows.map(toView);
  }

  /** 待企业管理员处理的申请数（后台概览）。 */
  async countPendingDeployment(): Promise<number> {
    const r = await this.db
      .selectFrom("directory_requests")
      .select(sql<string>`count(*)`.as("n"))
      .where("stage", "=", "deployment")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /**
   * 收件箱：当前用户是本组织管理员（实时读角色）时，返回待他处理的成员申请（stage org、pending），新的在前；
   * 否则为空。
   */
  async listForOrgAdmin(orgId: string, accountId: string): Promise<DirectoryRequestView[]> {
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!m || !roleAtLeast(m.role, "admin")) return [];
    const rows = await this.baseQuery(this.db)
      .where("r.org_id", "=", orgId)
      .where("r.stage", "=", "org")
      .where("r.status", "=", "pending")
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(DIRECTORY_REQUESTS_LIST_MAX)
      .execute();
    return rows.map(toView);
  }

  /** 本组织各条目最新的一条申请（组织目录列表用）。 */
  async latestByItem(
    orgId: string,
  ): Promise<Map<string, { id: string; stage: DirectoryRequestStage; status: string }>> {
    const rows = await this.db
      .selectFrom("directory_requests")
      .select(["id", "item_id", "stage", "status", "created_at"])
      .where("org_id", "=", orgId)
      .orderBy("created_at", "asc")
      .execute();
    const out = new Map<string, { id: string; stage: DirectoryRequestStage; status: string }>();
    for (const r of rows) out.set(r.item_id, { id: r.id, stage: r.stage, status: r.status });
    return out;
  }

  async view(db: KernelDb | Trx, id: string): Promise<DirectoryRequestView> {
    const row = await this.baseQuery(db).where("r.id", "=", id).executeTakeFirst();
    if (!row) throw requestNotFound();
    return toView(row);
  }

  private baseQuery(db: KernelDb | Trx) {
    return db
      .selectFrom("directory_requests as r")
      .innerJoin("directory_items as i", "i.id", "r.item_id")
      .innerJoin("orgs as o", "o.id", "r.org_id")
      .leftJoin("accounts as a", "a.id", "r.requested_by")
      .select([
        "r.id",
        "r.org_id",
        "o.name as org_name",
        "r.item_id",
        "i.kind",
        "i.name",
        "i.display_name",
        "r.version",
        "r.stage",
        "r.status",
        "r.note",
        "r.requested_by",
        "a.display_name as requested_by_name",
        "r.decided_by",
        "r.decided_at",
        "r.org_decided_by",
        "r.org_decided_at",
        "r.created_at",
      ]);
  }
}

function toView(r: {
  id: string;
  org_id: string;
  org_name: string;
  item_id: string;
  kind: PackageKind;
  name: string;
  display_name: LocalizedName | null;
  version: string | null;
  stage: DirectoryRequestStage;
  status: DirectoryRequestStatus;
  note: string;
  requested_by: string | null;
  requested_by_name: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  org_decided_by: string | null;
  org_decided_at: Date | null;
  created_at: Date;
}): DirectoryRequestView {
  return {
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    item: { id: r.item_id, kind: r.kind, name: r.name, displayName: r.display_name },
    version: r.version,
    stage: r.stage,
    status: r.status,
    note: r.note,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    orgDecidedBy: r.org_decided_by,
    orgDecidedAt: r.org_decided_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}
