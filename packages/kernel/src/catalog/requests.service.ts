import { randomUUID } from "node:crypto";
import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";

export type CatalogRequestStage = "org" | "deployment";
export type CatalogRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type CatalogDecision = "approve" | "reject";

/** A catalog request (the inbox's `catalog_request`, the enterprise admin request list). */
export interface CatalogRequestView {
  id: string;
  orgId: string;
  orgName: string;
  item: { id: string; name: string; displayName: LocalizedName | null };
  version: string | null;
  stage: CatalogRequestStage;
  status: CatalogRequestStatus;
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
export const CATALOG_REQUESTS_LIST_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestNotFound = () =>
  new ApiError("catalog.request_not_found", "Catalog request not found");
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const itemDisabled = () =>
  new ApiError(
    "catalog.item_disabled",
    "This catalog item is disabled by the enterprise admin and cannot be newly installed",
  );

/** 在调用方事务里读条目的策略（FOR SHARE：与企业管理员改策略 / 删除互斥）。不存在或已删除 → undefined。 */
async function lockItem(t: KernelSchemaDb, itemId: string) {
  if (!UUID_RE.test(itemId)) return undefined;
  return t
    .selectFrom("catalog_items")
    .select(["id", "name", "policy", "deleted_at"])
    .where("id", "=", itemId)
    .forShare()
    .executeTakeFirst();
}

async function hasGrant(db: KernelSchemaDb, orgId: string, itemId: string): Promise<boolean> {
  const g = await db
    .selectFrom("catalog_org_grants")
    .select("item_id")
    .where("item_id", "=", itemId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return g !== undefined;
}

/**
 * Before an org creates a component from the catalog (enabling an extension, creating a connector
 * from a template, importing a skill), re-checks the item policy in the caller's transaction (C22):
 * deleted or disabled -> `catalog.item_disabled`; needs_approval without an enterprise admin grant
 * for this org -> `catalog.approval_required`; allow or granted -> passes. A dependency's
 * components pass `approvedBy`, the item the org is installing (spec §10: approval follows the
 * installed plugin only): the dependency's own item must still be live and not disabled, and the
 * approval is judged by `approvedBy`.
 */
export async function assertItemInstallable(
  t: KernelSchemaDb,
  orgId: string,
  itemId: string,
  approvedBy: string = itemId,
): Promise<void> {
  if (approvedBy !== itemId) {
    const own = await lockItem(t, itemId);
    if (!own || own.deleted_at !== null || own.policy === "disabled") throw itemDisabled();
  }
  const item = await lockItem(t, approvedBy);
  if (!item || item.deleted_at !== null || item.policy === "disabled") throw itemDisabled();
  if (item.policy === "needs_approval" && !(await hasGrant(t, orgId, approvedBy))) {
    throw new ApiError(
      "catalog.approval_required",
      "This catalog item needs enterprise admin approval before this organization can install it",
    );
  }
}

/**
 * The extensions among `plugins` whose own catalog item (the non-deleted item with the same name) is
 * disabled (FOR SHARE: exclusive with policy changes). A disabled item is a master switch: no path
 * (direct enabling, its item, another plugin) can newly enable its extension (Ruling M-5).
 */
export async function disabledPluginItems(
  db: KernelSchemaDb,
  plugins: readonly string[],
): Promise<string[]> {
  if (plugins.length === 0) return [];
  const rows = await db
    .selectFrom("catalog_items")
    .select("name")
    .where("name", "in", [...plugins])
    .where("policy", "=", "disabled")
    .where("deleted_at", "is", null)
    .orderBy("name")
    .forShare()
    .execute();
  return [...new Set(rows.map((r) => r.name))];
}

/**
 * Throws `catalog.item_disabled` when a plugin's own catalog item is disabled (the message names
 * the plugin).
 */
export function pluginItemDisabled(names: readonly string[]): ApiError {
  return new ApiError(
    "catalog.item_disabled",
    `The enterprise admin disabled the catalog item of extension ${names.join(", ")}; it cannot be newly enabled, not even through a plugin that bundles it`,
  );
}

/**
 * When an org enables an extension directly (not by installing from an item, e.g.
 * `PUT /orgs/:orgId/extensions/:extension`), it is judged by every catalog item that brought it into the
 * deployment (`extension_catalog_sources`), and **the strictest wins**: any source disabled ->
 * `catalog.item_disabled`; otherwise any source needs_approval without a grant of that item to the
 * org -> `catalog.approval_required`; all allow / granted -> passes. Deleted items no longer count
 * as sources (an enterprise admin deleting an item withdraws its constraint). No source (not
 * installed through the catalog) -> not bound by catalog policy.
 */
export async function assertPluginSourcesInstallable(
  t: KernelSchemaDb,
  orgId: string,
  plugin: string,
): Promise<void> {
  const rows = await t
    .selectFrom("extension_catalog_sources as s")
    .innerJoin("catalog_items as i", "i.id", "s.item_id")
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
        "catalog.approval_required",
        "A catalog item that brought this extension in needs enterprise admin approval before this organization can enable it",
      );
    }
  }
}

/** 审计里带上 PAT（个人令牌发起时）。 */
export interface RequestActorOpts {
  actorTokenId?: string;
}

/**
 * Cancels catalog requests still pending in the caller's transaction (`db` is its handle; when the
 * item or the org is deleted), status `cancelled` (the decider is the actor). Each one audits
 * `catalog.request_cancelled` (with the reason). Returns how many were cancelled.
 */
export async function cancelPendingRequests(
  db: KernelSchemaDb,
  where: { itemId: string } | { orgId: string },
  actor: string,
  reason: "item_removed" | "org_deleted",
  opts: RequestActorOpts = {},
): Promise<number> {
  let q = db
    .updateTable("catalog_requests")
    .set({ status: "cancelled", decided_by: actor, decided_at: sql<Date>`now()` })
    .where("status", "=", "pending");
  q =
    "itemId" in where ? q.where("item_id", "=", where.itemId) : q.where("org_id", "=", where.orgId);
  const rows = await q.returning(["id", "org_id", "item_id", "stage"]).execute();
  for (const r of rows) {
    await audit(db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: r.org_id,
      action: "catalog.request_cancelled",
      target: r.id,
      detail: { itemId: r.item_id, stage: r.stage, reason },
    });
  }
  return rows.length;
}

/**
 * Catalog requests and approvals (C22 / F-AF). Two levels:
 * - a member request (stage `org`) goes to the org admins' inbox, an org admin (`catalog.decide`)
 *   approves or rejects it; when the item is needs_approval without a grant for this org, approving
 *   moves the request to stage `deployment` (still pending) for the enterprise admins to decide;
 * - an org admin installing a needs_approval item without a grant -> creates a stage `deployment`
 *   request (or moves the existing pending one there);
 * - an enterprise admin approving a stage `deployment` request -> writes a grant
 *   (`catalog_org_grants`, valid across versions), after which org admins can install.
 * One pending request per org and item (partial unique index; org-side writes all run inside the
 * org row lock, in order). No in-process state.
 */
@Injectable()
export class CatalogRequestsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The org row and enterprise admin locks (R12): both join the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * A member request (`catalog.request`, re-checked inside the org row lock). Item missing /
   * deleted -> `catalog.item_not_found`; disabled -> org admins get `catalog.item_disabled`,
   * members get `catalog.item_not_found` (members do not see disabled items). An existing pending
   * request is returned as is (`created: false`), no new one. Audits `catalog.requested`.
   */
  async request(
    orgId: string,
    actor: string,
    itemId: string,
    input: { note?: string | undefined; version?: string | undefined },
    opts: RequestActorOpts = {},
  ): Promise<{ request: CatalogRequestView; created: boolean }> {
    const r = await this.writeRequest(orgId, actor, itemId, input, opts);
    return { request: await this.view(r.id), created: r.created };
  }

  @Transactional()
  private async writeRequest(
    orgId: string,
    actor: string,
    itemId: string,
    input: { note?: string | undefined; version?: string | undefined },
    opts: RequestActorOpts,
  ): Promise<{ id: string; created: boolean }> {
    const t = this.db;
    const { role } = await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.request");
    const item = await lockItem(t, itemId);
    if (!item || item.deleted_at !== null) throw itemNotFound();
    // 成员看不到 disabled 的条目（列表、详情、图标一致）：同样答 not found，不暴露条目存在
    if (item.policy === "disabled") {
      throw roleAtLeast(role, "admin") ? itemDisabled() : itemNotFound();
    }
    const existing = await this.pendingRow(orgId, itemId);
    if (existing) return { id: existing.id, created: false };
    const id = randomUUID();
    await t
      .insertInto("catalog_requests")
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
      action: "catalog.requested",
      target: id,
      detail: { itemId, name: item.name, stage: "org" },
    });
    return { id, created: true };
  }

  private pendingRow(orgId: string, itemId: string) {
    return this.db
      .selectFrom("catalog_requests")
      .select(["id", "stage"])
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("status", "=", "pending")
      .executeTakeFirst();
  }

  /**
   * An org admin installing a needs_approval item without a grant: in the caller's transaction (the
   * caller has locked the org row and re-checked the role) creates a stage `deployment` request; an
   * existing pending request is moved to deployment (a member request goes to the enterprise admins
   * with it). Returns the request id. Audits `catalog.requested`.
   */
  @Transactional({ propagation: "mandatory" })
  async requestDeployment(
    orgId: string,
    actor: string,
    item: { id: string; name: string },
    version: string | null,
    opts: RequestActorOpts = {},
  ): Promise<string> {
    const t = this.db;
    const existing = await this.pendingRow(orgId, item.id);
    if (existing) {
      if (existing.stage === "org") {
        await t
          .updateTable("catalog_requests")
          .set({ stage: "deployment", org_decided_by: actor, org_decided_at: sql<Date>`now()` })
          .where("id", "=", existing.id)
          .execute();
        await audit(t, {
          actorAccountId: actor,
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          orgId,
          action: "catalog.request_decided",
          target: existing.id,
          detail: { itemId: item.id, decision: "approve", stage: "org", escalated: true },
        });
      }
      return existing.id;
    }
    const id = randomUUID();
    await t
      .insertInto("catalog_requests")
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
      action: "catalog.requested",
      target: id,
      detail: { itemId: item.id, name: item.name, stage: "deployment" },
    });
    return id;
  }

  /**
   * 安装成功后：本组织该条目仍 pending 的申请（成员申请 stage org，以及之前因 needs_approval 建的 stage deployment
   * 申请——条目之后改成 allow 再装的就不会一直挂着）标为 approved（安装者即决定人），收件箱与企业管理员列表随之清空。
   * 在调用方事务里执行。
   */
  @Transactional({ propagation: "mandatory" })
  async resolveByInstall(
    orgId: string,
    itemId: string,
    actor: string,
    opts: RequestActorOpts = {},
  ): Promise<void> {
    const t = this.db;
    const rows = await t
      .updateTable("catalog_requests")
      .set({ status: "approved", decided_by: actor, decided_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("status", "=", "pending")
      .returning(["id", "stage"])
      .execute();
    for (const r of rows) {
      await audit(t, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "catalog.request_decided",
        target: r.id,
        detail: { itemId, decision: "approve", stage: r.stage, installed: true },
      });
    }
  }

  /**
   * An org admin decides a member request (`catalog.decide`, re-checked inside the org row lock;
   * the request row FOR UPDATE). Not this org's request -> `catalog.request_not_found`; already
   * decided or handed to the enterprise admins -> `catalog.request_decided`. On approval: item
   * deleted or disabled -> `catalog.item_disabled`; needs_approval without a grant -> moved to stage
   * deployment (still pending); otherwise approved. Audits `catalog.request_decided`.
   */
  async decideOrg(
    orgId: string,
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    await this.writeDecideOrg(orgId, actor, requestId, decision, opts);
    return this.view(requestId);
  }

  @Transactional()
  private async writeDecideOrg(
    orgId: string,
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts,
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.decide");
    const row = await t
      .selectFrom("catalog_requests")
      .select(["id", "item_id", "stage", "status"])
      .where("id", "=", requestId)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw requestNotFound();
    if (row.status !== "pending" || row.stage !== "org") {
      throw new ApiError(
        "catalog.request_decided",
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
      .updateTable("catalog_requests")
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
      action: "catalog.request_decided",
      target: requestId,
      detail: { itemId: row.item_id, decision, stage: "org", escalated },
    });
  }

  /**
   * An enterprise admin decides a stage deployment request (re-checked inside the enterprise admin
   * lock; the request row FOR UPDATE). Missing or still at the org stage ->
   * `catalog.request_not_found`; already decided -> `catalog.request_decided`; on approval, item
   * deleted or disabled -> `catalog.item_disabled`, the request's org deleted ->
   * `catalog.request_not_found`. Approval writes a grant to `catalog_org_grants`. Audits
   * `catalog.request_decided` (with orgId).
   */
  async decideDeployment(
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    await this.writeDecideDeployment(actor, requestId, decision, opts);
    return this.view(requestId);
  }

  @Transactional()
  private async writeDecideDeployment(
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts,
  ): Promise<void> {
    const t = this.db;
    await this.adminLock.lockAndAuthorize(actor);
    const row = await t
      .selectFrom("catalog_requests")
      .select(["id", "org_id", "item_id", "stage", "status"])
      .where("id", "=", requestId)
      .forUpdate()
      .executeTakeFirst();
    if (row?.stage !== "deployment") throw requestNotFound();
    if (row.status !== "pending") {
      throw new ApiError("catalog.request_decided", "This request has already been decided");
    }
    if (decision === "approve") {
      const item = await lockItem(t, row.item_id);
      if (!item || item.deleted_at !== null || item.policy === "disabled") throw itemDisabled();
      const org = await t
        .selectFrom("orgs")
        .select("deleted_at")
        .where("id", "=", row.org_id)
        .executeTakeFirst();
      if (!org || org.deleted_at !== null) throw requestNotFound();
      await t
        .insertInto("catalog_org_grants")
        .values({ item_id: row.item_id, org_id: row.org_id, granted_by: actor })
        .onConflict((oc) => oc.columns(["item_id", "org_id"]).doNothing())
        .execute();
    }
    await t
      .updateTable("catalog_requests")
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
      action: "catalog.request_decided",
      target: requestId,
      detail: { itemId: row.item_id, decision, stage: "deployment" },
    });
  }

  /** 企业管理员的申请列表（stage deployment；`status` 缺省 pending），新的在前。 */
  async listDeployment(q: { status?: CatalogRequestStatus } = {}): Promise<CatalogRequestView[]> {
    const rows = await this.baseQuery()
      .where("r.stage", "=", "deployment")
      .where("r.status", "=", q.status ?? "pending")
      .where("o.deleted_at", "is", null)
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    return rows.map(toView);
  }

  /** 待企业管理员处理的申请数（后台概览）。 */
  async countPendingDeployment(): Promise<number> {
    const r = await this.db
      .selectFrom("catalog_requests as r")
      .innerJoin("orgs as o", "o.id", "r.org_id")
      .select(sql<string>`count(*)`.as("n"))
      .where("r.stage", "=", "deployment")
      .where("r.status", "=", "pending")
      .where("o.deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /**
   * 收件箱：当前用户是本组织管理员（实时读角色）时，返回待他处理的成员申请（stage org、pending），新的在前；
   * 否则为空。
   */
  async listForOrgAdmin(orgId: string, accountId: string): Promise<CatalogRequestView[]> {
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!m || !roleAtLeast(m.role, "admin")) return [];
    const rows = await this.baseQuery()
      .where("r.org_id", "=", orgId)
      .where("r.stage", "=", "org")
      .where("r.status", "=", "pending")
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    return rows.map(toView);
  }

  /** 本组织各条目最新的一条申请（组织目录列表用）。 */
  async latestByItem(
    orgId: string,
  ): Promise<Map<string, { id: string; stage: CatalogRequestStage; status: string }>> {
    const rows = await this.db
      .selectFrom("catalog_requests")
      .select(["id", "item_id", "stage", "status", "created_at"])
      .where("org_id", "=", orgId)
      .orderBy("created_at", "asc")
      .execute();
    const out = new Map<string, { id: string; stage: CatalogRequestStage; status: string }>();
    for (const r of rows) out.set(r.item_id, { id: r.id, stage: r.stage, status: r.status });
    return out;
  }

  async view(id: string): Promise<CatalogRequestView> {
    const row = await this.baseQuery().where("r.id", "=", id).executeTakeFirst();
    if (!row) throw requestNotFound();
    return toView(row);
  }

  private baseQuery() {
    return this.db
      .selectFrom("catalog_requests as r")
      .innerJoin("catalog_items as i", "i.id", "r.item_id")
      .innerJoin("orgs as o", "o.id", "r.org_id")
      .leftJoin("accounts as a", "a.id", "r.requested_by")
      .select([
        "r.id",
        "r.org_id",
        "o.name as org_name",
        "r.item_id",
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
  name: string;
  display_name: LocalizedName | null;
  version: string | null;
  stage: CatalogRequestStage;
  status: CatalogRequestStatus;
  note: string;
  requested_by: string | null;
  requested_by_name: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  org_decided_by: string | null;
  org_decided_at: Date | null;
  created_at: Date;
}): CatalogRequestView {
  return {
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    item: { id: r.item_id, name: r.name, displayName: r.display_name },
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
