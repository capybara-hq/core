import { Inject, Injectable } from "@nestjs/common";
import {
  CATALOG_REQUESTS_LIST_MAX,
  CatalogRequestsService,
  type CatalogRequestView,
} from "../catalog/requests.service.js";
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

/** 收件箱一次最多返回的事项数。 */
export const INBOX_MAX_ITEMS = 100;

/**
 * 收件箱里的一项（按 `type` 区分，形状稳定）：
 * - `tool_approval`：当前用户能处理的待处理工具调用审批（与 `GET /approvals?status=pending` 同一视图）；
 * - `skill_change`：当前用户作为 agent 负责人能决定的待处理技能变更（M5 T15，R4）；
 * - `catalog_request`: pending catalog requests from members, when the current user is an org
 *   admin (M6 T26, C22).
 */
export type InboxItem =
  | { type: "tool_approval"; id: string; createdAt: string; approval: ApprovalView }
  | { type: "skill_change"; id: string; createdAt: string; skillChange: SkillChangeView }
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequestView };

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
    @Inject(CatalogRequestsService)
    private readonly catalogRequests: Pick<CatalogRequestsService, "listForOrgAdmin">,
  ) {}

  async list(orgId: string, accountId: string): Promise<InboxView> {
    const [approvals, changes, requests] = await Promise.all([
      this.approvals.list(orgId, accountId, "pending"),
      this.skillChanges.listPending(orgId, accountId),
      this.catalogRequests.listForOrgAdmin(orgId, accountId),
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
      requests.length >= CATALOG_REQUESTS_LIST_MAX;
    return {
      items: all.slice(0, INBOX_MAX_ITEMS),
      truncated: full || all.length > INBOX_MAX_ITEMS,
    };
  }
}
