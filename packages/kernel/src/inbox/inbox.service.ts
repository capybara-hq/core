import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  CATALOG_REQUESTS_LIST_MAX,
  CatalogRequestsService,
  type CatalogRequestView,
} from "../catalog/requests.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { roleAtLeast } from "../orgs/roles.js";
import {
  SKILL_CHANGES_LIST_MAX,
  SkillChangesService,
  type SkillChangeView,
} from "../skills/changes.service.js";
import {
  APPROVALS_LIST_MAX,
  ApprovalsService,
  type ApprovalView,
} from "../tools/approvals.service.js";
import type { OrgNoticeDetails } from "./org-notices.js";

/** The most open org notices one inbox read returns. */
export const ORG_NOTICES_LIST_MAX = 100;

/** The skill the platform components migration renamed (`skill_renamed`). */
export interface SkillRenamedDetail {
  skillId: string;
  from: string;
  to: string;
  platformSkillId: string;
  plugin: string | null;
}

/**
 * A notice for the org's admins (`org_notices`), shown until one of them dismisses it; `kind`
 * picks the detail field that is set:
 * - `skill_renamed` (`skillRenamed`): the platform components migration renamed an org skill whose
 *   name a platform skill on in the org has; agents keep it, by id;
 * - `item_shared`, `shared_item_updated`, `upload_confirmed`, `upload_rejected` (`detail`): the
 *   shapes of {@link OrgNoticeDetails} (plugin scope phase 3, P3-22).
 */
export type OrgNoticeView = { id: string; createdAt: string } & (
  | { kind: "skill_renamed"; skillRenamed: SkillRenamedDetail }
  | {
      [K in keyof OrgNoticeDetails]: { kind: K; detail: OrgNoticeDetails[K] };
    }[keyof OrgNoticeDetails]
);

/** 收件箱一次最多返回的事项数。 */
export const INBOX_MAX_ITEMS = 100;

/**
 * 收件箱里的一项（按 `type` 区分，形状稳定）：
 * - `tool_approval`：当前用户能处理的待处理工具调用审批（与 `GET /approvals?status=pending` 同一视图）；
 * - `skill_change`：当前用户作为 agent 负责人能决定的待处理技能变更（M5 T15，R4）；
 * - `catalog_request`: pending `enable` requests from members, when the current user is an org
 *   admin (M6 T26, C22; plugin scope spec §5.1);
 * - `catalog_request_decided`: the current user's own requests in this org that were approved or
 *   rejected (with the reason), until dismissed (`POST catalog-requests/:id/dismiss`);
 * - the org notices (`skill_renamed`, `item_shared`, `shared_item_updated`, `upload_confirmed`,
 *   `upload_rejected`; `type` = the notice's kind): for org admins, until one dismisses it
 *   (`POST inbox/notices/:id/dismiss`).
 */
export type InboxItem =
  | { type: "tool_approval"; id: string; createdAt: string; approval: ApprovalView }
  | { type: "skill_change"; id: string; createdAt: string; skillChange: SkillChangeView }
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequestView }
  | {
      type: "catalog_request_decided";
      id: string;
      /** When it was decided. */
      createdAt: string;
      request: CatalogRequestView;
    }
  | {
      type: OrgNoticeView["kind"];
      id: string;
      createdAt: string;
      notice: OrgNoticeView;
    };

/** `GET /inbox` 的结果：新的在前，最多 {@link INBOX_MAX_ITEMS} 项；`truncated` 为 true 表示还有更多。 */
export interface InboxView {
  items: InboxItem[];
  truncated: boolean;
}

/** 收件箱（计划取舍 C6）：按类型汇总各来源的待处理事项。无状态，每次实时读 PG。 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(ApprovalsService) private readonly approvals: Pick<ApprovalsService, "list">,
    @Inject(SkillChangesService)
    private readonly skillChanges: Pick<SkillChangesService, "listPending">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CatalogRequestsService)
    private readonly catalogRequests: Pick<
      CatalogRequestsService,
      "listForOrgAdmin" | "listDecidedForRequester"
    >,
  ) {}

  async list(orgId: string, accountId: string): Promise<InboxView> {
    const [approvals, changes, requests, decided, notices] = await Promise.all([
      this.approvals.list(orgId, accountId, "pending"),
      this.skillChanges.listPending(orgId, accountId),
      this.catalogRequests.listForOrgAdmin(orgId, accountId),
      this.catalogRequests.listDecidedForRequester(orgId, accountId),
      this.notices(orgId, accountId),
    ]);
    const all: InboxItem[] = [
      ...approvals.map(
        (a): InboxItem => ({
          type: "tool_approval",
          id: a.id,
          createdAt: a.createdAt,
          approval: a,
        }),
      ),
      ...changes.map(
        (c): InboxItem => ({
          type: "skill_change",
          id: c.id,
          createdAt: c.createdAt,
          skillChange: c,
        }),
      ),
      ...requests.map(
        (r): InboxItem => ({
          type: "catalog_request",
          id: r.id,
          createdAt: r.createdAt,
          request: r,
        }),
      ),
      ...decided.map(
        (r): InboxItem => ({
          type: "catalog_request_decided",
          id: r.id,
          createdAt: r.decidedAt ?? r.createdAt,
          request: r,
        }),
      ),
      ...notices.map(
        (n): InboxItem => ({ type: n.kind, id: n.id, createdAt: n.createdAt, notice: n }),
      ),
    ];
    // 新的在前；同一时刻按 id 定序（结果稳定）
    all.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    // 各来源自己也有上限：某个来源取满了也算还有更多
    const full =
      approvals.length >= APPROVALS_LIST_MAX ||
      changes.length >= SKILL_CHANGES_LIST_MAX ||
      requests.length >= CATALOG_REQUESTS_LIST_MAX ||
      decided.length >= CATALOG_REQUESTS_LIST_MAX ||
      notices.length >= ORG_NOTICES_LIST_MAX;
    return {
      items: all.slice(0, INBOX_MAX_ITEMS),
      truncated: full || all.length > INBOX_MAX_ITEMS,
    };
  }

  /** The org's open notices when the account is an org admin (else none), newest first. */
  private async notices(orgId: string, accountId: string): Promise<OrgNoticeView[]> {
    if (!(await this.isAdmin(orgId, accountId))) return [];
    const rows = await this.kdb.db
      .selectFrom("org_notices")
      .select(["id", "kind", "detail", "created_at"])
      .where("org_id", "=", orgId)
      .where("dismissed_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(ORG_NOTICES_LIST_MAX)
      .execute();
    return rows.map((r): OrgNoticeView => {
      const base = { id: r.id, createdAt: r.created_at.toISOString() };
      if (r.kind === "skill_renamed") {
        return { ...base, kind: r.kind, skillRenamed: r.detail as unknown as SkillRenamedDetail };
      }
      return { ...base, kind: r.kind, detail: r.detail } as OrgNoticeView;
    });
  }

  /**
   * An org admin dismisses an open notice (`POST /orgs/:orgId/inbox/notices/:id/dismiss`); for
   * every admin of the org. Not an admin, or no open notice of the org with that id ->
   * `inbox.notice_not_found`.
   */
  async dismissNotice(orgId: string, accountId: string, id: string): Promise<void> {
    const notFound = new ApiError("inbox.notice_not_found", "Notice not found");
    if (!UUID_RE.test(id) || !(await this.isAdmin(orgId, accountId))) throw notFound;
    const r = await this.kdb.db
      .updateTable("org_notices")
      .set({ dismissed_at: sql<Date>`now()`, dismissed_by: accountId })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw notFound;
  }

  private async isAdmin(orgId: string, accountId: string): Promise<boolean> {
    const m = await this.kdb.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return m !== undefined && roleAtLeast(m.role, "admin");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
